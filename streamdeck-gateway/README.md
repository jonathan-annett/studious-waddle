Quick-Start Guide for your Developer

Architecture: The Gateway is a "Thin Client." It handles the USB bus and image slicing locally on the i7 to keep the WebSocket traffic light.

Hot-Plugging: It polls every 2 seconds. No need to restart the app when plugging/unplugging Decks.

Image Zones: The 4x4 zone is visually "locked" (no white flash) to preserve the image integrity.

Mini Fix: All indices are parsed as integers to prevent the node-hid library from throwing errors on Gen 1 devices.