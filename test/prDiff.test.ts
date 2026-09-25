import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitPatch } from '../src/renderer/src/lib/prDiff.ts'

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 keep
--- a line that looks like a header
+new
@@ -10,2 +10,3 @@
 ctx
+added
diff --git a/new file.md b/new file.md
new file mode 100644
--- /dev/null
+++ b/new file.md
@@ -0,0 +1,2 @@
+# Title
+body
diff --git a/old.ts b/renamed.ts
similarity index 90%
rename from old.ts
rename to renamed.ts
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`

test('splits a patch into one entry per file', () => {
  const files = splitPatch(PATCH)
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary, f.oldPath]),
    [
      ['src/a.ts', 'M', 2, 1, false, undefined],
      ['new file.md', 'A', 2, 0, false, undefined],
      ['renamed.ts', 'R', 0, 0, false, 'old.ts'],
      ['gone.txt', 'D', 0, 1, false, undefined],
      ['logo.png', 'M', 0, 0, true, undefined]
    ]
  )
})

test("each file's text starts at its own header and ends with a newline", () => {
  const [first, second] = splitPatch(PATCH)
  assert.ok(first.text.startsWith('diff --git a/src/a.ts'))
  assert.ok(!first.text.includes('new file.md'))
  assert.ok(second.text.endsWith('+body\n'))
})

test('an empty patch has no files', () => {
  assert.deepEqual(splitPatch(''), [])
})
