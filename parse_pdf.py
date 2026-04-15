import fitz
import sys, json

doc = fitz.open(sys.argv[1])
page = doc[0]
blocks = page.get_text("dict")["blocks"]
text_data = []
for b in blocks:
    if b["type"] == 0:
        for l in b["lines"]:
            for s in l["spans"]:
                text_data.append({"text": s["text"], "size": s["size"], "bbox": list(s["bbox"])})
drawings = []
for d in page.get_drawings():
    drawings.append({"rect": list(d.get("rect")), "fill": d.get("fill"), "color": d.get("color"), "items_count": len(d.get("items", []))})
print(json.dumps({"rect": list(page.rect), "text": text_data, "drawings_count": len(drawings), "drawings_sample": drawings[:5]}, indent=2))
