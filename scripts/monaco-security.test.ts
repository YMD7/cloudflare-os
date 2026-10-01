import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

test("Monacoの同梱版ではなく修正済みDOMPurifyを使用する", () => {
  const require = createRequire(new URL("../packages/workshop-frontend/package.json", import.meta.url));
  const entry = require.resolve("monaco-editor/base/browser/domSanitize.js");
  assert.match(readFileSync(entry, "utf8"), /import purify from 'dompurify';/);
  const createPurifier = createRequire(entry)("dompurify");
  assert.equal(createPurifier.version, "3.4.16");

  // Monacoと同じimport先を使い、イベント属性とscriptの除去も確認する。
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("");
  try {
    const clean = createPurifier(dom.window).sanitize(
      '<b>safe</b><img src="x" onerror="alert(1)"><script>alert(1)</script>',
    );
    assert.equal(clean, '<b>safe</b><img src="x">');
  } finally {
    dom.window.close();
  }
});
