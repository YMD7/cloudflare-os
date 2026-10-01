import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

// CDNの既定版を使用せず、セキュリティpatch適用済みのMonacoとworkerを同一originから配信する。
globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    switch (label) {
      case 'json': return new JsonWorker()
      case 'css': case 'scss': case 'less': return new CssWorker()
      case 'html': case 'handlebars': case 'razor': return new HtmlWorker()
      case 'typescript': case 'javascript': return new TsWorker()
      default: return new EditorWorker()
    }
  },
}
loader.config({ monaco })

export { Editor } from '@monaco-editor/react'
