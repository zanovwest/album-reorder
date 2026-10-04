# Album Reorder

Ever had an album where the tracklist just feels wrong? Drag the tracks into the order you want, right on the album page, the same way you'd move songs in a playlist. Spotify then plays the album in your order.

![Dragging Fellow Feeling below Goodbye To A World on Porter Robinson's Worlds](preview.png)

## Usage

- **Reorder:** drag a track on any album page. A green line shows where it will land. Drop it, and the list renumbers itself straight away. You can drag several selected tracks at once.
- **Play:** the album's Play button starts at your first track. Clicking a track, skipping forward and skipping back all follow your order, and Spotify's autoplay picks up after your last track.
- **Reset:** albums with a custom order get a **Reset order** button next to the "…" button. Right-clicking the album also gives you **Reset track order**.

![Reset order button in the album's action bar](reset-button.png)

Orders are saved locally in Spotify, per album, and survive restarts.

## Install

**Marketplace:** search for "Album Reorder" in the Spicetify Marketplace and click Install.

**Manually:** copy `albumReorder.js` into your Spicetify `Extensions` folder (`spicetify path userdata` shows where it is), then run:

```
spicetify config extensions albumReorder.js
spicetify apply
```

## Good to know

- With shuffle on, Spotify's shuffle wins.
- Albums with more than 50 tracks can't be reordered, since Spotify loads those in chunks.
- On multi-disc albums, the disc split is removed while a custom order is active, and tracks are numbered 1 to N.
- If an album is already loaded and paused, its Play button resumes it. That's normal Spotify behaviour.
- This extension relies on Spotify's internal player and page code. It was built and tested on Spotify 1.3.3 with Spicetify 2.45. A future Spotify update may break it. Everything it changes is wrapped in fallbacks, so most likely it would just stop reordering.

## How it works

- Album pages are served in your order by rewriting Spotify's own `getAlbum` response, so the page renders natively.
- Playback starts at your first track, and Spotify's "Next up" queue is rewritten to follow your order whenever the album starts playing.
