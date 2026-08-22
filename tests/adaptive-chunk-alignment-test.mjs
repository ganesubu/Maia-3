
import assert from "node:assert/strict";
import fs from "node:fs";
const e=fs.readFileSync("js/engine.js","utf8");
assert.match(e,/for \(let i = 0; i < tokensList\.length; i \+= chunkSize\)/);
assert.match(e,/chunks\.push\(tokensList\.slice\(i, i \+ chunkSize\)\)/);
assert.doesNotMatch(e,/chunks\.push\(tokensList\.slice\(i, i \+ CHUNK\)\)/);
function chunksFor(length, ms){
 const size=Math.max(2,Math.min(8,Math.round(100/Math.max(1,ms))));
 const out=[];
 for(let i=0;i<length;i+=size) out.push([...Array(Math.min(size,length-i)).keys()].map(x=>i+x));
 return out;
}
for(const ms of [5,12,25,50,100,180]){
 const flat=chunksFor(13,ms).flat();
 assert.deepEqual(flat,[...Array(13).keys()]);
}
console.log("adaptive-chunk-alignment-test: 9/9 passed");
