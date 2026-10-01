import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ config: vi.fn<(options: { monaco: unknown }) => void>() }))
vi.mock('@monaco-editor/react', () => ({ loader: { config: mocks.config }, Editor: {} }))
vi.mock('monaco-editor', () => ({ editor: {} }))
vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({ default: class EditorWorker {} }))
vi.mock('monaco-editor/language/json/json.worker.js?worker', () => ({ default: class JsonWorker {} }))
vi.mock('monaco-editor/language/css/css.worker.js?worker', () => ({ default: class CssWorker {} }))
vi.mock('monaco-editor/language/html/html.worker.js?worker', () => ({ default: class HtmlWorker {} }))
vi.mock('monaco-editor/language/typescript/ts.worker.js?worker', () => ({ default: class TypeScriptWorker {} }))

describe('ローカルMonacoのセキュリティ修正', () => {
  it('CDN版を読み込まず、言語ごとのローカルworkerを提供する', async () => {
    await import('./monaco')
    expect(mocks.config).toHaveBeenCalledWith({ monaco: await import('monaco-editor') })
    const worker = globalThis.MonacoEnvironment!.getWorker!
    for (const [label, name] of [
      ['editorWorkerService', 'EditorWorker'], ['json', 'JsonWorker'],
      ['css', 'CssWorker'], ['html', 'HtmlWorker'], ['javascript', 'TypeScriptWorker'],
    ]) {
      expect((await worker('', label)).constructor.name).toBe(name)
    }
  })
})
