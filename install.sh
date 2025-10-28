#!/bin/bash
set -e

# Update package list
apt-get update -y

# Install curl, ffmpeg, and basic dependencies
apt-get install -y curl ffmpeg

# Download yt-dlp (latest release)
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp

echo "✅ yt-dlp and ffmpeg installed successfully"
