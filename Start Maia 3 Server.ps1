param(
    [ValidateRange(1,65535)]
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

# IMPORTANT:
# Derive the project root from this script's own location. Do not accept the
# root path from cmd.exe; that avoids Windows quoting/trailing-backslash issues.
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Root = [System.IO.Path]::GetFullPath($Root)

$listener = $null

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

function Resolve-LocalPath([string]$RequestPath) {
    try {
        $decoded = [Uri]::UnescapeDataString($RequestPath)
    }
    catch {
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

    $rootPrefix = $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) +
                  [System.IO.Path]::DirectorySeparatorChar

    if (-not $candidate.StartsWith(
        $rootPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -and
        $candidate -ne $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar)) {
        return $null
    }

    if (Test-Path -LiteralPath $candidate -PathType Container) {
        $candidate = Join-Path $candidate "index.html"
    }

    return $candidate
}

function Write-Response(
    [System.Net.Sockets.NetworkStream]$stream,
    [int]$status,
    [string]$reason,
    [byte[]]$body,
    [string]$contentType
) {
    $header =
        "HTTP/1.1 $status $reason`r`n" +
        "Content-Type: $contentType`r`n" +
        "Content-Length: $($body.Length)`r`n" +
        "Cache-Control: no-cache`r`n" +
        "Connection: close`r`n`r`n"

    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)

    if ($body.Length -gt 0) {
        $stream.Write($body, 0, $body.Length)
    }
}

try {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw "Project folder not found: $Root"
    }

    $index = Join-Path $Root "index.html"
    if (-not (Test-Path -LiteralPath $index -PathType Leaf)) {
        throw "index.html was not found in: $Root"
    }

    $listener = New-Object System.Net.Sockets.TcpListener(
        [System.Net.IPAddress]::Any,
        $Port
    )
    $listener.Start()

    Write-Host ""
    Write-Host "======================================"
    Write-Host " Maia 3 portable server"
    Write-Host "======================================"
    Write-Host "Folder : $Root"
    Write-Host "Local  : http://localhost:$Port/"
    Write-Host "Phone  : http://YOUR-PC-IP:$Port/"
    Write-Host ""
    Write-Host "Opening browser..."
    Write-Host ""

    # The listener is already bound here, so the browser cannot race the server.
    Start-Process "http://localhost:$Port/"

    while ($true) {
        $client = $listener.AcceptTcpClient()

        try {
            $stream = $client.GetStream()
            $stream.ReadTimeout = 10000
            $stream.WriteTimeout = 30000

            $buffer = New-Object byte[] 16384
            $bytesRead = $stream.Read($buffer, 0, $buffer.Length)
            if ($bytesRead -le 0) { continue }

            $request = [System.Text.Encoding]::ASCII.GetString(
                $buffer, 0, $bytesRead
            )
            $firstLine = ($request -split "`r?`n")[0]

            if ($firstLine -notmatch '^(GET|HEAD)\s+(\S+)\s+HTTP\/1\.[01]$') {
                $body = [System.Text.Encoding]::UTF8.GetBytes("400 Bad Request")
                Write-Response $stream 400 "Bad Request" $body "text/plain; charset=utf-8"
                continue
            }

            $method = $matches[1]
            $target = $matches[2]
            $pathOnly = ($target -split "\?")[0]
            $file = Resolve-LocalPath $pathOnly

            if ($null -eq $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
                $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                Write-Response $stream 404 "Not Found" $body "text/plain; charset=utf-8"
                continue
            }

            $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
            $contentType = if ($mime.ContainsKey($ext)) {
                $mime[$ext]
            } else {
                "application/octet-stream"
            }

            if ($method -eq "HEAD") {
                Write-Response $stream 200 "OK" ([byte[]]@()) $contentType
            }
            else {
                $body = [System.IO.File]::ReadAllBytes($file)
                Write-Response $stream 200 "OK" $body $contentType
            }
        }
        catch {
            # Ignore browser disconnects and keep serving.
        }
        finally {
            try { $stream.Dispose() } catch {}
            try { $client.Dispose() } catch {}
        }
    }
}
catch {
    Write-Host ""
    Write-Host "Maia 3 could not start its local server."
    Write-Host ""
    Write-Host $_.Exception.Message
    Write-Host ""
    Write-Host "If port $Port is already in use, try:"
    Write-Host "    Start Maia 3.bat 8001"
    Write-Host ""
    exit 1
}
finally {
    if ($null -ne $listener) {
        try { $listener.Stop() } catch {}
    }
}
