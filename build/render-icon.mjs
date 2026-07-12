import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8')
const out = process.argv[2] || join(dir, 'icon-1024.png')

const html = `<!doctype html><html><head><meta charset="utf8"><style>
  html,body{margin:0;padding:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
</style></head><body>${svg}</body></html>`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage()
  writeFileSync(out, img.toPNG())
  console.log('wrote', out, img.getSize())
  app.quit()
})
