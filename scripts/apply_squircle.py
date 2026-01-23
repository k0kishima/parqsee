import os
from PIL import Image, ImageDraw

def create_squircle_mask(size, radius_ratio=0.225):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    w, h = size
    # Using continuous formatting to avoid syntax errors in complex shapes
    # Actually, a simple rounded rectangle is close enough for most users, 
    # but let's try to be precise if possible. 
    # For simplicity and robustness in this environment, we use a rounded rectangle 
    # with the specific macOS curvature (~22.5%).
    
    # Draw rounded rectangle
    # The 'radius' for 1024px is approx 230px
    radius = int(min(w, h) * radius_ratio)
    
    # Check if PIL version supports rounded_rectangle (Pillow >= 8.2.0)
    # If not, we fallback to standard arcs.
    if hasattr(draw, "rounded_rectangle"):
        draw.rounded_rectangle([(0, 0), size], radius=radius, fill=255)
    else:
        # Fallback implementation
        x0, y0, x1, y1 = 0, 0, w, h
        d = radius * 2
        draw.rectangle([x0+radius, y0, x1-radius, y1], fill=255)
        draw.rectangle([x0, y0+radius, x1, y1-radius], fill=255)
        draw.pieslice([x0, y0, x0+d, y0+d], 180, 270, fill=255)
        draw.pieslice([x1-d, y0, x1, y0+d], 270, 360, fill=255)
        draw.pieslice([x1-d, y1-d, x1, y1], 0, 90, fill=255)
        draw.pieslice([x0, y1-d, x0+d, y1], 90, 180, fill=255)
        
    return mask

def apply_mask():
    # Determine project root based on script location (./scripts/apply_squircle.py -> ../)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, '..'))
    
    input_path = os.path.join(project_root, "backend", "icons", "source_icon.png")
    output_path = input_path # Overwrite existing
    
    # Scale factor to reduce visual size (0.9 = 90% size, 10% padding divided by 2)
    # This addresses the "too large/floating" issue.
    SCALE_FACTOR = 0.9
    
    if not os.path.exists(input_path):
        print(f"Error: Source icon not found at {input_path}")
        exit(1)
        
    try:
        # Load original
        img = Image.open(input_path).convert("RGBA")
        original_size = img.size
        
        # 1. Resize visual content
        new_size = (int(original_size[0] * SCALE_FACTOR), int(original_size[1] * SCALE_FACTOR))
        img_resized = img.resize(new_size, Image.Resampling.LANCZOS)
        
        # 2. Create new transparent background 1024x1024 (or original size)
        background = Image.new("RGBA", original_size, (0, 0, 0, 0))
        
        # 3. Paste resized image in center
        offset_x = (original_size[0] - new_size[0]) // 2
        offset_y = (original_size[1] - new_size[1]) // 2
        background.paste(img_resized, (offset_x, offset_y))
        
        # 4. Create Squircle mask for the RESIZED content
        # We need the mask to match the new resized shape to clip it correctly
        # OR, we clip the original image then resize? 
        # Better: Create mask at new_size, then paste it into a full-size transparent mask.
        
        small_mask = create_squircle_mask(new_size)
        full_mask = Image.new("L", original_size, 0)
        full_mask.paste(small_mask, (offset_x, offset_y))
        
        # 5. Apply combined mask
        background.putalpha(full_mask)
        
        # Save
        background.save(output_path, "PNG")
        print(f"Successfully resized to {SCALE_FACTOR*100}% and applied mask to {output_path}")
        
    except Exception as e:
        print(f"Error processing image: {e}")
        exit(1)

if __name__ == "__main__":
    apply_mask()
