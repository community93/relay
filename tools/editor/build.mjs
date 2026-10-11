import {build} from 'esbuild';
import {readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const output=join(root,'../../web/js/vendor');
mkdirSync(output,{recursive:true});
const result=await build({entryPoints:[join(root,'core.js')],outfile:join(output,'editor-core.js'),bundle:true,format:'esm',minify:true,target:'chrome105',legalComments:'eof',metafile:true});
for(const pkg of ['state','view']){
  const copies=Object.keys(result.metafile.inputs).filter(file=>file.replaceAll('\\','/').endsWith(`/@codemirror/${pkg}/dist/index.js`));
  if(copies.length!==1)throw new Error(`CodeMirror ${pkg} must have exactly one bundled copy: ${copies.join(', ')}`);
}
const licenses=[];
function scan(folder){
  for(const name of readdirSync(folder,{withFileTypes:true})){
    if(!name.isDirectory()||name.name.startsWith('.'))continue;
    const dir=join(folder,name.name);
    if(name.name.startsWith('@')){scan(dir);continue;}
    if(!existsSync(join(dir,'package.json')))continue;
    const pkg=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
    if(pkg.name==='esbuild'||pkg.name.startsWith('@esbuild/'))continue;
    const license=['LICENSE','LICENSE.txt','LICENSE.md'].find(file=>existsSync(join(dir,file)));
    if(license)licenses.push(`${pkg.name} ${pkg.version}\n${readFileSync(join(dir,license),'utf8')}`);
  }
}
scan(join(root,'node_modules'));
writeFileSync(join(output,'editor-LICENSES.txt'),licenses.join('\n\n---\n\n'));
