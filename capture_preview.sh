#!/bin/bash
google-chrome --headless=new --disable-gpu --screenshot=/tmp/omoide_canvas.png --window-size=1280,900 http://localhost:8000/
cp /tmp/omoide_canvas.png /home/k3and4/.gemini/antigravity/brain/4a6b7ae5-2fcc-4ce9-8a31-824642a57f6e/screenshot_canvas.png
echo "Screenshot updated successfully!"
