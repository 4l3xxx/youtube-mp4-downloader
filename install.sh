#!/bin/bash
set -e

# Update package list
apt-get update -y

# Install ffmpeg
apt-get install -y ffmpeg

# Install yt-dlp (latest)
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp

echo "✅ yt-dlp and ffmpeg installed successfully"

