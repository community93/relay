import {el, modal, toast} from './ui.js';
import {registerVariableEditor} from './variables.js';
import {EditorState, StateEffect, EditorView, Compartment, Prec, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, rectangularSelection, placeholder,
  history, isolateHistory, historyKeymap, defaultKeymap, indentWithTab, undo, redo, syntaxHighlighting, HighlightStyle,
  bracketMatching, indentOnInput, indentUnit, foldGutter, foldKeymap, syntaxTree,
  closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap, acceptCompletion,
  json, jsonParser, linter, lintGutter, setDiagnostics, search, searchKeymap, highlightSelectionMatches, tags,
} from './vendor/editor-core.js';

const sessions=new WeakMap(), live=new Set();
let observer;
const colors=HighlightStyle.define([
  {tag:tags.propertyName,color:'var(--tok-key)'},
  {tag:tags.string,color:'var(--tok-str)'},
  {tag:tags.number,color:'var(--tok-num)'},
  {tag:[tags.bool,tags.null],color:'var(--tok-bool)'},
  {tag:tags.punctuation,color:'var(--text-dim)'},
]);

// Unquoted template values are resolved on send. Replace only those tokens,
// retaining every offset so diagnostics still point into the original text.
function templateJson(text){
  let out='',quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(!quoted&&text.slice(i,i+2)==='{{'){
      const token=/^\{\{[\w$.-]+\}\}/.exec(text.slice(i));
      if(token){out+='0'+' '.repeat(token[0].length-1);i+=token[0].length-1;continue;}
    }
    out+=ch;
    if(escaped){escaped=false;continue;}
    if(quoted&&ch==='\\'){escaped=true;continue;}
    if(ch==='"')quoted=!quoted;
  }
  return out;
}

function diagnostics(text){
  if(!text.trim())return [];
  try{JSON.parse(templateJson(text));return [];}catch(error){
    let pos=Number(/position (\d+)/i.exec(error.message)?.[1]);
    if(!Number.isFinite(pos)){
      const location=/line (\d+) column (\d+)/i.exec(error.message);
      if(location)pos=text.split('\n').slice(0,Number(location[1])-1).reduce((n,line)=>n+line.length+1,0)+Number(location[2])-1;
      else {
        pos=text.length;
        jsonParser.parse(templateJson(text)).iterate({enter:node=>{if(node.type.isError)pos=Math.min(pos,node.from);}});
      }
    }
    pos=Math.max(0,Math.min(pos,text.length));
    return [{from:pos,to:Math.min(text.length,pos+1),severity:'error',message:error.message.replace(/ at position.*$| \(line .*$/,'')}];
  }
}

function literals(ctx){
  const word=ctx.matchBefore(/[A-Za-z]+/);
  if(!word&&!ctx.explicit)return null;
  const from=word?.from??ctx.pos;
  const node=syntaxTree(ctx.state).resolveInner(from,-1);
  if(/String|PropertyName/.test(node.name))return null;
  const before=ctx.state.sliceDoc(0,from).trimEnd();
  if(!/[:\[,]$/.test(before)&&before!=='')return null;
  // A comma in an object expects a property name, not a literal value.
  let parent=node;
  while(parent&&!['Object','Array'].includes(parent.name))parent=parent.parent;
  if(before.endsWith(',')&&parent?.name==='Object')return null;
  return {from,options:['true','false','null'].map(label=>({label,type:'keyword'})),validFor:/^[A-Za-z]*$/};
}

export function createBodyEditor({tab,language,content,onChange,languageControl}){
  const isJson=language==='json', wrap=new Compartment();
  const panel=el('div',{class:'editor body-editor'});
  const mount=el('div',{class:'body-code'});
  const position=el('span',{class:'body-cursor mono'});
  const count=el('span',{class:'right faint small'});
  const health=el('button',{class:'body-health',type:'button','aria-label':isJson?'JSON 校验状态':'正文编码'});
  const status=el('div',{class:'body-editor-status'},[health,position,count]);
  let view,issues=[],timer,expanded=false;
  const updateStatus=()=>{
    const selection=view.state.selection.main, line=view.state.doc.lineAt(selection.head);
    position.textContent=`${line.number}:${selection.head-line.from+1}`;
    position.title='行 : 列';
    count.textContent=`${view.state.doc.length.toLocaleString()} 字符`;
  };
  const showIssues=(next)=>{
    issues=next;
    health.classList.toggle('invalid',issues.length>0);
    health.textContent=!isJson?'UTF-8':issues.length?`JSON · 第 ${view.state.doc.lineAt(issues[0].from).number} 行有误`:view.state.doc.length?'JSON · 有效':'JSON';
    health.title=issues[0]?.message||'JSON 语法检查 · 模板变量在发送时解析';
    health.disabled=!issues.length;
  };
  const check=()=>{const next=isJson?diagnostics(view.state.doc.toString()):[];showIssues(next);return next;};
  const jump=()=>{
    // The debounced marker may refer to text that has just been deleted.
    check();
    if(!issues.length)return;
    view.dispatch({selection:{anchor:issues[0].from},effects:EditorView.scrollIntoView(issues[0].from,{y:'center'})});view.focus();
  };
  health.onclick=jump;
  const format=(compact=false)=>{
    try{
      const text=view.state.doc.toString();
      // JSON.stringify would change unquoted templates; keep them as tokens.
      const replacements=[];
      let encoded='',quoted=false,escaped=false;
      for(let i=0;i<text.length;i++){
        const ch=text[i],token=!quoted&&/^\{\{[\w$.-]+\}\}/.exec(text.slice(i));
        if(token){let marker=`__RELAY_TEMPLATE_${replacements.length}__`;while(text.includes(marker))marker+='_';replacements.push([JSON.stringify(marker),token[0]]);encoded+=JSON.stringify(marker);i+=token[0].length-1;continue;}
        encoded+=ch;if(escaped){escaped=false;continue;}if(quoted&&ch==='\\'){escaped=true;continue;}if(ch==='"')quoted=!quoted;
      }
      let result=JSON.stringify(JSON.parse(encoded||'{}'),null,compact?undefined:2);
      for(const [marker,token] of replacements)result=result.replace(marker,()=>token);
      view.dispatch({changes:{from:0,to:view.state.doc.length,insert:result},selection:{anchor:Math.min(view.state.selection.main.head,result.length)},annotations:isolateHistory.of('full'),userEvent:'input.format'});view.focus();
    }catch(error){view.dispatch(setDiagnostics(view.state,check()));jump();toast('JSON 有误，请检查标记位置','err');}
  };
  const wrapButton=el('button',{class:'btn ghost sm',text:'换行','aria-label':'请求体自动换行','aria-pressed':String(!!sessions.get(tab)?.wrap),onclick:()=>{
    const enabled=wrapButton.getAttribute('aria-pressed')!=='true';wrapButton.setAttribute('aria-pressed',String(enabled));
    view.dispatch({effects:wrap.reconfigure(enabled?EditorView.lineWrapping:[])});
    sessions.get(tab).wrap=enabled;
  }});
  const expandButton=el('button',{class:'btn ghost sm',text:'展开',title:'展开编辑请求体',onclick:()=>{
    if(expanded)return;expanded=true;
    const anchor=document.createComment('body-editor');panel.replaceWith(anchor);
    modal({title:'请求体',width:1040,body:[panel],cancelText:'完成',onMount:({box})=>{box.classList.add('body-editor-dialog');setTimeout(()=>{if(expanded)view.focus();},60);},onClose:()=>{
      expanded=false;expandButton.disabled=false;
      if(anchor.isConnected){anchor.replaceWith(panel);requestAnimationFrame(()=>view.focus());}
      else {panel.remove();destroy();}
    }});
    expandButton.disabled=true;requestAnimationFrame(()=>view.focus());
  }});
  const toolbar=el('div',{class:'editor-bar body-editor-toolbar'},[
    languageControl||el('span',{class:'body-language mono',text:'JSON'}),
    isJson?el('button',{class:'btn ghost sm',text:'格式化 JSON',title:'格式化 JSON · Shift+Alt+F',onclick:()=>format()}):null,
    isJson?el('button',{class:'btn ghost sm',text:'压缩',onclick:()=>format(true)}):null,
    el('span',{class:'grow'}),wrapButton,expandButton,
  ]);
  panel.append(toolbar,mount,status);
  const previous=sessions.get(tab), initialWrap=previous?.wrap||false;
  const extensions=[
    EditorState.phrases.of({
      'Find':'查找','Replace':'替换','next':'下一个','previous':'上一个','all':'全部',
      'match case':'区分大小写','regexp':'正则','by word':'完整单词',
      'replace':'替换','replace all':'全部替换','close':'关闭',
      'Go to line':'跳转到行','go':'跳转','Fold line':'折叠','Unfold line':'展开',
      'current match':'当前匹配','on line':'行','No matches found':'无匹配',
    }),
    lineNumbers(),highlightActiveLineGutter(),drawSelection(),rectangularSelection(),highlightActiveLine(),
    history(),indentUnit.of('  '),indentOnInput(),bracketMatching(),closeBrackets(),
    wrap.of(initialWrap?EditorView.lineWrapping:[]),
    EditorView.contentAttributes.of({'aria-label':isJson?'JSON 请求体':'请求体内容','data-variable-syntax':language,spellcheck:'false'}),
    placeholder(isJson?'{\n  "name": "Relay"\n}':'输入请求内容…'),
    Prec.highest(EditorView.domEventHandlers({keydown:(event,editor)=>{
      if(event.isComposing||(!event.ctrlKey&&!event.metaKey)||event.altKey)return false;
      const key=event.key.toLowerCase();
      if(key!=='z'&&key!=='y')return false;
      event.preventDefault();
      (key==='y'||event.shiftKey?redo:undo)(editor);
      return true;
    }})),
    keymap.of([
      {key:'Shift-Alt-f',run:()=>{if(!isJson)return false;format();return true;}},
      {key:'Tab',run:acceptCompletion},...closeBracketsKeymap,...completionKeymap,
      {key:'Mod-z',run:undo,shift:redo,preventDefault:true},
      indentWithTab,...defaultKeymap,...historyKeymap.filter(binding=>binding.key!=='Mod-z'),...foldKeymap,...searchKeymap,
    ]),
    search({top:true}),highlightSelectionMatches(),
    EditorView.updateListener.of(update=>{
      sessions.set(tab,{state:update.state,language,wrap:wrapButton.getAttribute('aria-pressed')==='true',scroll:view?.scrollDOM.scrollTop||0});
      if(update.docChanged){onChange(update.state.doc.toString());clearTimeout(timer);timer=setTimeout(check,350);}
      if(update.docChanged||update.selectionSet)updateStatus();
    }),
    ...(isJson?[json(),syntaxHighlighting(colors),foldGutter(),lintGutter(),linter(()=>check(),{delay:350}),autocompletion({override:[literals],defaultKeymap:false})]:[]),
  ];
  view=new EditorView({parent:mount,state:previous?.language===language&&previous.state.doc.toString()===content
    ?previous.state:EditorState.create({doc:content,extensions})});
  // Reconfigure closures when restoring history/selection from a previous render.
  if(previous?.language===language&&previous.state.doc.toString()===content){
    view.dispatch({effects:StateEffect.reconfigure.of(extensions)});
  }
  sessions.set(tab,{state:view.state,language,wrap:initialWrap,scroll:previous?.scroll||0});
  view.scrollDOM.addEventListener('scroll',()=>{const saved=sessions.get(tab);if(saved)saved.scroll=view.scrollDOM.scrollTop;});
  const unregister=registerVariableEditor(view.contentDOM,{
    get value(){return view.state.doc.toString();},
    get selectionStart(){return view.state.selection.main.from;},get selectionEnd(){return view.state.selection.main.to;},
    setRangeText(insert,from,to){view.dispatch({changes:{from,to,insert},selection:{anchor:from+insert.length},annotations:isolateHistory.of('full'),userEvent:'input.complete'});},
    caretRect(){const rect=view.coordsAtPos(view.state.selection.main.head)||view.contentDOM.getBoundingClientRect();return {x:rect.left,y:rect.top,height:rect.bottom-rect.top};},
  });
  let destroyed=false;
  const destroy=()=>{if(destroyed)return;destroyed=true;clearTimeout(timer);unregister();view.destroy();live.delete(entry);};
  const entry={panel,destroy};live.add(entry);
  if(!observer){observer=new MutationObserver(()=>{for(const item of live)if(!item.panel.isConnected)item.destroy();});observer.observe(document.body,{childList:true,subtree:true});}
  requestAnimationFrame(()=>{if(!destroyed){view.scrollDOM.scrollTop=previous?.scroll||0;view.requestMeasure();}});
  updateStatus();check();
  return panel;
}
