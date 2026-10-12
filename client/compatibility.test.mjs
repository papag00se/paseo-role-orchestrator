import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the real client entry and forms without a native renderer. Host primitives
// are distinct from ordinary RN primitives, so modal keyboard/scroll integration is observable.
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  react: moduleUrl(`export const useMemo=f=>f(); export const useEffect=()=>{};
    export const useState=v=>[typeof v==='function'?v():v,()=>{}];`),
  'react/jsx-runtime': moduleUrl(`export const Fragment='Fragment';
    export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;`),
  'react-native': moduleUrl(`export const ActivityIndicator='ActivityIndicator', Pressable='Pressable',
    ScrollView='NativeScrollView', TextInput='NativeTextInput', Text='Text', View='View';
    export const StyleSheet={create:x=>x};`),
  '@getpaseo/plugin/client': moduleUrl(`export const usePaseo=()=>({}); export const useRpc=()=>async()=>({});
    export const useWorkspace=()=>null; export const useAgent=()=>null;`),
  '@getpaseo/plugin/client/react-native': moduleUrl(`export const Icon='Icon', TextInput='HostTextInput',
    ScrollView='HostScrollView'; export const Modal=Object.assign(()=>{}, {Content:'ModalContent'});
    export const useToast=()=>({error(){},show(){}});`),
  '@tanstack/react-query': moduleUrl(`export const useQuery=()=>({isLoading:false});
    export const useMutation=()=>({mutate(){}}); export const useQueryClient=()=>({invalidateQueries(){}});`),
};
registerHooks({
  resolve(specifier, context, next) {
    if (mocks[specifier]) return {url:mocks[specifier],shortCircuit:true};
    try { return next(specifier,context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) {
        for (const extension of ['.ts','.tsx']) {
          try { return next(specifier+extension,context); } catch {}
        }
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('.tsx')) return {format:'module', shortCircuit:true, source:ts.transpileModule(
      readFileSync(new URL(url),'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}
    ).outputText};
    return next(url,context);
  },
});
const {default:contribute} = await import('../index.client.tsx');
const {RoleCatalogSurface,RoleWorkspacePanel,RoleAgentPanel} = await import('./main.tsx');
function nodes(tree) {
  if (!tree || typeof tree!=='object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree,...nodes(tree.props?.children)];
}

test('current client entry preserves settings, contextual panels and settings action', () => {
  const settings=[], panels=[], commands=[];
  const cleanup=contribute({addSettingsScreen:x=>settings.push(x),addWorkspacePanel:x=>panels.push(x),addCommandCenterItem:x=>commands.push(x)});
  assert.deepEqual(settings.map(x=>x.id),['roles','completion-gate']);
  assert.equal(settings[0].Component,RoleCatalogSurface);
  assert.deepEqual(panels.map(x=>[x.id,x.context]),[['roles-workspace','workspace'],['roles-agent','agent']]);
  assert.equal(panels[0].Component,RoleWorkspacePanel);
  assert.equal(panels[1].Component,RoleAgentPanel);
  let opened;
  commands[0].onSelect({openSettings:id=>opened=id});
  assert.equal(opened,'roles');
  cleanup();
});

test('role editor uses one host scroll owner and sheet-aware inputs in wide and compact layouts', () => {
  const theme={colors:new Proxy({}, {get:(_,key)=>String(key)})};
  for (const compact of [false,true]) {
    const catalog=RoleCatalogSurface({theme,host:{id:'host'},layout:{compact,platform:'web'}});
    const editor=nodes(catalog).find(x=>typeof x.type==='function' && x.props?.onSave);
    assert.ok(editor,'catalog still mounts the role editor');
    const form=nodes(editor.type({...editor.props,open:true}));
    assert.equal(form.filter(x=>x.type==='ModalContent').length,1);
    assert.equal(form.filter(x=>['HostScrollView','NativeScrollView'].includes(x.type)).length,0,'Modal.Content owns vertical scrolling');
    assert.equal(form.filter(x=>x.type==='HostTextInput').length,3,'name, description and role prompt use sheet-aware inputs');
    assert.equal(form.filter(x=>x.type==='NativeTextInput').length,0);
    assert.ok(form.filter(x=>x.type==='Text').every(x=>x.props.style),'text remains theme styled');
  }
});
