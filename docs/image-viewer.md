# The image viewer

*Part of Carbon's design notes. The contract, the session flow and the provider
seams are in `CLAUDE.md`; the other surfaces are the neighbouring files in this
directory.*

### The image viewer (`ImageView.tsx`)

Click an image in a message and it opens full-window, sized in real pixels
inside a scroller so panning is the browser's own job.

- **Every image in a message opens it, and for a long time only one kind did.**
  The lightbox was keyed on a filesystem *path*, so the only clickable image was
  the one that has one — a markdown `![](/abs/file.png)` the agent wrote
  (`LocalImage`). A tool's returned screenshot (`ToolOutputImages`), a `data:` or
  `http(s)` image in prose and a prompt's own attachment were plain `<img>` tags
  with no handler at all, which is exactly backwards: the tool-result capture is
  the **common** case, since the session rules tell the agent an image block
  already satisfies "show me a screenshot" and not to write the markdown
  duplicate. The symptom was a screenshot that opened on Tuesday and not on
  Wednesday, decided by which path the agent happened to take. `LightboxTarget`
  is therefore `{kind:'file'}` | `{kind:'data'}`, and the one asymmetry it keeps
  is the header's **Open as a tab**: a data image has no file to open, so that
  button belongs to the kind rather than to the viewer. `ImageView` itself
  already took a `src` and needed no change.
- **Scale is device pixels, not CSS pixels.** Nearly every image here is a
  Retina screenshot, where a CSS-pixel 100% is *twice* the size the capture was
  taken at — so a window filled edge to edge reported **43%**, a number that
  reads as a bug rather than as a fitted picture. 100% is now one image pixel
  per physical screen pixel, which is Preview's meaning of the word and the only
  one that is true of these files. `width = natural × scale ÷ dpr`, and `dpr`
  is tracked live (`useDevicePixelRatio`) because it moves with both the display
  and the UI zoom.
- **The size is read twice, and the second read is the one that matters.**
  `load` fires *before* React attaches `onLoad` whenever the picture is already
  decoded — which is every click on one, since it was just on screen in the
  transcript. The event never arrives, so an unmeasured image renders at its
  *intrinsic* size: a 2× screenshot at 3024px in a 1377px pane, clipped, with
  every zoom control moving the percentage and nothing else. A layout effect
  reads `complete`/`naturalWidth` off the element for that case, and beats the
  paint that would show it.
- **A plain scroll pans; only ⌘-scroll and pinch zoom.** The bail condition also
  required `deltaY === 0`, so every ordinary two-finger scroll zoomed instead —
  and scrolling back only zoomed the other way, which is what left a picture
  stuck too large with no way out.
- **Fit subtracts the padding the image sits in.** Counting that room as usable
  made the content 32px wider than the pane at "fit", so the fitted state always
  carried a scrollbar.

- **An image in the transcript opens here too, and most of them have no file.**
  `LightboxTarget` is `file | data`, because the two are not the same object: a
  local path is read at open and can also be opened as a tab, where a tool's
  returned screenshot, a `data:` URI in a reply and an image attached to a
  prompt only ever existed as bytes in the transcript. That is why "Open as a
  tab" belongs to the `file` kind rather than to the viewer. The attachment chip
  is the case that needs the click most: it is `object-cover`, so it is
  *cropped*, and opening it is the only way back to what was actually sent.
