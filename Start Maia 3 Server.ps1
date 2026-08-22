param(
    [Parameter(Mandatory=$true)]
    [string]$Root,

    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
$Root = [System.IO.Path]::GetFullPath($Root)
$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)

$mime = @{
    ".html" = "text/html; charset=utf-8"
    ".htm"  = "text/html; charset=utf-8"
    ".js"   = "text/javascript; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".webp" = "image/webp"
    ".wasm" = "application/wasm"
    ".bin"  = "application/octet-stream"
    ".txt"  = "text/plain; charset=utf-8"
    ".md"   = "text/markdown; charset=utf-8"
    ".ico"  = "image/x-icon"
}

function Send-Response {
    param(
        [System.Net.Sockets.NetworkStream]$Stream,
        [int]$Status,
        [string]$Reason,
        [byte[]]$Body,
        [string]$ContentType = "text/plain; charset=utf-8"
    )

    $header = "HTTP/1.1 $Status $Reason`r`n" +
              "Content-Type: $ContentType`r`n" +
              "Content-Length: $($Body.Length)`r`n" +
              "Cache-Control: no-cache`r`n" +
              "Connection: close`r`n`r`n"

    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
}

function Get-LocalFilePath {
    param([string]$RequestPath)

    try {
        $decoded = [Uri]::UnescapeDataString($RequestPath)
    } catch {
        return $null
    }

    $decoded = $decoded -replace '/', [System.IO.Path]::DirectorySeparatorChar
    $decoded = $decoded.TrimStart([System.IO.Path]::DirectorySeparatorChar)

    if ($decoded -match '(^|[\\/])\.\.([\\/]|$)') {
        return $null
    }

    $candidate = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::Combine($Root, $decoded)
    )

    $rootWithSlash = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
        [System.IO.Path]::DirectorySeparatorChar

    if (-not $candidate.StartsWith($rootWithSlash, [System.StringComparison]::OrdinalIgnoreCase) -and
        $candidate -ne $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar)) {
        return $null
    }

    if (Test-Path -LiteralPath $candidate -PathType Container) {
        $candidate = [System.IO.Path]::Combine($candidate, "index.html")
    }

    return $candidate
}

try {
    $listener.Start()
    Write-Host ""
    Write-Host "Maia 3 portable server"
    Write-Host "Serving: $Root"
    Write-Host "Local:   http://localhost:$Port/"
    Write-Host "Network: http://YOUR-PC-IP:$Port/"
    Write-Host "Press Ctrl+C to stop."
    Write-Host ""

    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 5000
            $stream.WriteTimeout = 5000

            $buffer = New-Object byte[] 8192
            $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
            if ($bytesRead -le 0) {
                $stream.Dispose()
                $client.Dispose()
                continue
            }

            $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $bytesRead)
            $firstLine = ($request -split "`r?`n")[0]

            if ($firstLine -notmatch '^GET\s+(\S+)\s+HTTP\/1\.[01]$' -and
                $firstLine -notmatch '^HEAD\s+(\S+)\s+HTTP\/1\.[01]$') {
                $body = [System.Text.Encoding]::UTF8.GetBytes("400 Bad Request")
                Send-Response -Stream $stream -Status 400 -Reason "Bad Request" -Body $body
                continue
            }

            $method = if ($firstLine.StartsWith("HEAD ")) { "HEAD" } else { "GET" }
            $requestTarget = if ($firstLine -match '^(?:GET|HEAD)\s+(\S+)\s+') { $matches[1] } else { "/" }
            $pathOnly = ($requestTarget -split "\?")[0]

            $file = Get-LocalFilePath $pathOnly
            if ($null -eq $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
                $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                Send-Response -Stream $stream -Status 404 -Reason "Not Found" -Body $body
                continue
            }

            $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
            $contentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }

            if ($method -eq "HEAD") {
                Send-Response -Stream $stream -Status 200 -Reason "OK" -Body ([byte[]]@()) -ContentType $contentType
            } else {
                $body = [System.IO.File]::ReadAllBytes($file)
                Send-Response -Stream $stream -Status 200 -Reason "OK" -Body $body -ContentType $contentType
            }
        } catch {
            # The browser may disconnect while a large asset is being sent.
            # Ignore that request and keep the server alive.
        } finally {
            try { $stream.Dispose() } catch {}
            try { $client.Dispose() } catch {}
        }
    }
}
finally {
    try { $listener.Stop() } catch {}
}
