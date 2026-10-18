# Replay Cam (PolyTrack 0.6.3, PolyModLoader)

ReplayMod-style cinematic cameras for PolyTrack replays. Place camera keyframes in a replay,
play them back as one smooth shot with slow motion and speed ramps, and save the result as a
video. It only changes the camera and playback, not physics, so it works next to other mods
and in vanilla-compatible sessions.

## Installing

Same as Car Collisions:

1. Create a public GitHub repository, double-click `Upload to GitHub.cmd` and paste the
   repository address when asked. Turn on GitHub Pages for the repository (Settings, Pages,
   branch `main`, folder `/ (root)`). Later uploads are just the double-click.
2. In the loader (https://w.polymodloader.com), import `https://<user>.github.io/<repo>/dist`.

## Opening a replay

Leaderboard: pick a run, then **Watch**. During a race, the **Watch** button at the top left
also works. The Replay Cam panel appears at the top right.

## Making a shot

1. **Space** pauses. Drag the game's timeline (or click the bar in the panel) to the moment
   the shot starts.
2. **/** turns on the free camera: WASD to fly, Z/C for down/up, Shift to go faster, drag the
   mouse to look. Replay Cam adds **Q/E** to tilt, the **mouse wheel** to zoom, and **R** to
   reset tilt and zoom.
3. **K** adds a keyframe: the camera's position, direction, tilt and zoom at this moment of
   the replay.
4. Move to a later moment, move the camera, press **K** again. Repeat.
5. **G** plays the path (press G again to stop). The game's UI and the panel hide while it
   plays.

The camera glides through every keyframe on a smooth curve.

| What | How |
|---|---|
| Slow motion | Set a keyframe's **x** field (playback speed) to 0.25. Speed changes smoothly between keyframes, so 1 then 0.25 then 1 gives a speed ramp. **[** and **]** set the speed for new keyframes, and for normal playback outside a path. |
| Freeze-frame orbit | Add two or more keyframes at the *same* replay time from different camera positions. Time stands still while the camera moves between them. The **hold** field sets how long that takes. |
| Keep the car centred | **F** (Aim at car) makes the free camera always look at the car, so you only steer its position. Keyframes added with it on have **aim** ticked, which keeps the car centred during the path. Ticking aim on some keyframes and not others blends between the two. |
| 9:16 guide | **V** darkens everything outside the part a Short keeps. |
| Edit a keyframe | **Go** jumps there; **Set** replaces it with the current camera and time; ▶ plays from there; × deletes it. |
| Save or share a path | Paths are saved in the browser and come back the next time you open a replay. **Copy path** / **Paste path** move one between PCs. |
| Hide the panel | **B** |

## Recording

- **Record 9:16** plays the path and saves a `.webm` video of the middle 9:16 strip (up to
  1080x1920). **Record full** saves the whole picture. Neither includes the game's UI or the
  panel; there is no sound.
- The video is cut from the game's picture, so its sharpness depends on the window size. For
  a sharp 9:16 video, set **Render scale** to 2 in the game's settings, or make the window
  tall. At render scale 1 in a 1920x1080 window, the 9:16 strip is only 608x1080.
- Playback follows the clock: if the game stutters while recording, the video stutters too.
  Lower the graphics settings if that happens.
- You can also leave Replay Cam's recording off and record with OBS while pressing G. The
  path holds its first frame for half a second first, which gives a clean start to cut at.

## Limits

- Replays store one physics step per millisecond. Below about 0.25x, the car can step
  slightly unevenly from frame to frame.
- The path starts and stops moving abruptly at its first and last keyframes. Trim a moment
  off either end if that shows.
- Only the replay viewer is supported, not live driving.

## Building and testing

```
node build.js                 # src/ -> dist/
node test/path.test.mjs       # camera-path maths
node test/live-server.js      # the mod in the local PolyTrack AI game, without the loader
```

`test/live-server.js` starts the PolyTrack AI server (`../polytrack-ai`) on port 8772 and
serves the game on http://localhost:8125 with the mod added. The tracks with runs saved
on this PC have leaderboards there to watch. The preview config `replaycam-test` runs it.

## How it works

`getFromPolyTrack` gives access to the replay viewer (`Sg`), the free camera (`wt`) and the
viewer's private fields (time `lg`, timeline `ug`, renderer `eg`). `Sg.prototype.update` is
wrapped: during a path, the viewer is advanced by exactly the difference between the path's
replay time and the current one, so sound and effects keep running. The free camera's update is
wrapped to pose the camera after the viewer has moved it and before the frame is drawn. Video is
recorded by copying each drawn frame into a separate canvas and recording that with
MediaRecorder.
