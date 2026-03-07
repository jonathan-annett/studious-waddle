# DMX Dashboard — Operator Guide

## What Is This?

This system lets you control NEC large-format display TVs using your lighting console (grandMA, ETC Ion, QLab, etc.) via **sACN** — the same network protocol that carries DMX lighting data over Ethernet.

Each TV on the network can be assigned a **DMX universe**, and once it has one, every channel in that universe controls a specific aspect of the display: power, brightness, which folder to display, etc.

You can also **control TVs manually** using a web dashboard if your console isn't available or you just want quick access.

---

## Getting Started

### Find Your Dashboard

Open a browser and go to:
```
http://<server-ip>:4000/dmx/<universe-number>
```

For example, if your server is at `192.168.100.1` and your TV is assigned universe **10**:
```
http://192.168.100.1:4000/dmx/10
```

You'll see a full-screen control panel for that TV.

### The Status Badge

In the top-right corner, you'll see:

- **● CONSOLE** (blue) — Your lighting console is actively sending DMX to this universe. The dashboard mirrors what your console is doing (read-only).
- **○ MANUAL** (grey) — No console, or the console has stopped sending. All buttons and sliders work.
- **⚠ CONSOLE LOST** (amber flash) — You had a console connected, but the network connection dropped. The dashboard automatically switches to manual control.

---

## Using Your Console

### Channel Map

Each TV universe has the same channel layout:

| Channel | Control | Range | Example |
|---------|---------|-------|---------|
| CH1 | **Show Mode Enable** | 0 = off, 1–255 = on | Bring this up to activate console control; the scheduler will stand aside. |
| CH2 | **Power** | 0–127 = off, 128–255 = on | Cross the midpoint to toggle power. |
| CH3 | **Input Select** | 0=no change, 1–50=HDMI1, 51–100=HDMI2, 101–150=DP1, 151–200=DP2, 201–255=Media Player | Pick which input the TV shows. If all folder faders go to zero, CH3 is the fallback. |
| CH4–9 | **VCP Controls** | 0–255 → 0–100% | Brightness, Contrast, Backlight, Sharpness, Volume, Colour Temperature. |
| CH101–510 | **Folder Faders** | ≥128 = active | Each fader represents a folder on the TV's SD card. See "Folder Control" below. |

### Folder Control

The TV's media player can display slideshow folders from the SD card. Each folder gets its own channel.

**How it works:**

- **One fader at ≥128 (50%+):** TV plays that folder.
- **All faders below 128:** TV stops the slideshow and switches to the input specified by **CH3**.
- **Two or more faders at ≥128:** The system is in a "**crossfade window**" — no change happens. This lets you crossfade smoothly between folders without the display flickering mid-transition.

**Example:**
1. Bring up **CH 103** (Keynote Slides) to 200.
2. TV switches to that folder and plays.
3. Bring up **CH 105** (Product Demo) while 103 is still up.
4. Both are now active — TV keeps playing Keynote (no interruption during your crossfade).
5. Drop **CH 103** below 128.
6. Now only 105 is active — TV switches to Product Demo.

---

## Using Manual Mode (No Console)

If you don't have a console, or it's temporarily unavailable, use the web dashboard to control everything.

### The Control Panel

**Blackout button** — The big red button. Instantly powers off the TV.

**Power buttons** — Turn the display on or off independently of brightness.

**Input buttons** — Choose HDMI1, HDMI2, DP1, DP2, or Media Player.

**Folder grid** — Shows all configured folders with thumbnails. Click any folder to play it.
- **Bright green border** = currently playing
- **Pulsing border** = crossfade in progress (you have multiple faders up on a console, or the system is still settling)

**Sliders** — Adjust brightness, contrast, backlight, sharpness, volume, and colour temperature.

### Switching Between Modes

If a console connects while you're in **manual mode**, the dashboard will:
1. Turn blue (console mode).
2. Switch all controls to read-only — you'll see the console's values in real time.
3. Show a **"Take Manual Control"** button if you need to regain command.

If the console **drops offline** after being connected:
1. Dashboard flashes amber.
2. Automatically switches back to manual mode after 3 seconds.
3. All buttons work again — no action needed from you.

---

## Last-Minute Content (Bespoke Upload)

### The Scenario

It's 5 minutes before showtime. Someone hands you a USB stick and says, "Can we add this logo video to the display?"

**Yes.** The dashboard has a drag-and-drop upload feature for exactly this.

### How to Upload

1. Scroll down to **"Bespoke Content"** and click to expand.
2. **Drag and drop** your files (images or video) onto the grey box, or click to browse.
3. Enter a **folder name** (e.g., `ClientLogoV2`).
4. Set the **seconds per slide** (how long each image shows before moving to the next; video just plays through once).
5. Click **⬆ Upload**.
6. Wait for the success message.
7. The new folder appears in the **Folder grid** with a **⚡** badge — it's temporary.
8. Click it to play it like any other folder.

### After the Show

When you're done with temporary folders:
1. Click **"End Show — Remove All Temporary Content"** in the bespoke section.
2. Confirm the delete.
3. All `_show_` folders are wiped from the SD card.

**Why this design?** Temporary content is isolated with a special naming prefix (`_show_`), so it can never accidentally overwrite official show content. And it's explicitly cleaned up — nothing lingers on the player.

---

## Troubleshooting

### "I'm not seeing the dashboard"

1. Check the server address — is it spelled right? (e.g., `192.168.100.1:4000`)
2. Is the network cable plugged in?
3. Is the server running? (You should hear a faint fan whir. If not, ask the tech team.)
4. Try a different browser (Chrome, Firefox, Safari).

### "All the buttons are greyed out / not responding"

You're probably in **console mode** and the console is in control. Either:
- Switch back to the console and adjust there, or
- Click **"Take Manual Control"** in the top-right.

### "My console is sending DMX but the TV isn't reacting"

1. **Check the universe number.** The dashboard URL shows which universe you're on. Make sure your console is patching to the same universe.
2. **Check CH1.** Bring **CH1 above 0**. This activates "show mode" and tells the server to listen to the console. If CH1 is at 0, the server ignores the rest of the DMX data.
3. **Check the TV's IP address.** This should be set in the main admin interface. Ask the tech team if you're not sure.

### "The console was working, then suddenly went read-only"

Your network connection to the console probably dropped. The dashboard will show an amber **"CONSOLE LOST"** message and automatically switch to manual mode after 3 seconds. Click a button to confirm you're taking control, and it'll turn back to grey.

### "I uploaded a file but it's not showing up"

1. Make sure the folder name is unique — don't upload twice with the same name.
2. The upload takes a few seconds depending on file size. Wait for the green checkmark.
3. Scroll down in the folder list — new uploads appear at the bottom.

### "The TV is completely black / no image"

1. Check the **input selector**. Maybe it switched to a disconnected input.
2. Try the **Power** buttons — power it off, wait 5 seconds, power it back on.
3. If it's still black, there may be a hardware issue. Ask the tech team.

---

## Tips for Smooth Shows

1. **Test your console patch before showtime.** Bring up a single folder fader to confirm the TV responds.

2. **Use CH1 strategically.** Only bring CH1 above 0 when you're actively controlling the TV from the console. When you're done, drop it back to 0. This lets the system's built-in scheduler take over and restore the default content automatically if someone manually switches the input.

3. **Don't upload huge video files.** A 2–5 MB video is fine. Gigabyte files will take forever to upload and might bog down the system. For long videos, ask the tech team to add them beforehand.

4. **Plan your crossfades.** Remember: bring the new folder up while the old one is still playing (two faders active = no change), then drop the old one. Smooth as silk.

5. **Know where the manual dashboard is.** If the console dies mid-show, you can always grab a laptop and use the web dashboard to keep going.

---

## The Main Admin Interface

If you need to **assign universes to TVs** or **set up folders**, go to:
```
http://<server-ip>:4000
```

This is the main configuration page. Most operators won't need to touch this — but if you do, expand a device card and you'll see a DMX section where you can:
- Assign a universe number
- Configure which folders map to which channels
- Clean up old temporary folders from outside the dashboard

---

## Questions?

Ask your tech team or the operator who set up the system. They'll have the server IP, any custom folder names, and can help debug network issues.

**Happy showing!**
