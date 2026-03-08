#!/bin/sh
# A generic reusable script to fetch a statically compiled x86_64 FFmpeg binary
# Useful for bypassing restricted package manager builds.

INSTALL_DIR="${1:-/root/ffmpeg_static}"

echo "Installing required utilities for download and extraction..."
opkg update
opkg install wget-ssl xz tar

echo "Preparing installation directory at $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR" || { echo "Failed to enter directory"; exit 1; }

echo "Downloading static x86_64 FFmpeg release..."
# Using John Van Sickle's widely trusted static Linux builds
wget -qO ffmpeg-static.tar.xz "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"

if [ $? -ne 0 ]; then
    echo "Download failed. Please check your internet connection."
    exit 1
fi

echo "Extracting binary (this may take a moment)..."
tar -xf ffmpeg-static.tar.xz --strip-components=1

# Clean up the archive
rm ffmpeg-static.tar.xz

echo "Installation complete!"
echo "You can now run FFmpeg with all decoders using: $INSTALL_DIR/ffmpeg"