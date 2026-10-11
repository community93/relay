"""Generate Relay's geometric R mark for the UI, executable and Windows shell."""
import io
import struct
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
ICONS = ROOT / 'src-tauri' / 'icons'
WEB = ROOT / 'web' / 'img'
INK = '#08645d'
PATH = 'M300 738V286H538C670 286 742 349 742 445C742 536 672 600 546 600H406V738H300Z M406 382V504H534C599 504 636 486 636 444C636 402 599 382 534 382H406Z'
TAIL_PATH = 'M520 638H646L754 738H612Z'

def cubic(start, a, b, end):
    return [tuple((1-t)**3*start[i] + 3*(1-t)**2*t*a[i] + 3*(1-t)*t*t*b[i] + t**3*end[i] for i in range(2)) for t in [n/48 for n in range(1,49)]]

OUTER = [(300,738),(300,286),(538,286)] + cubic((538,286),(670,286),(742,349),(742,445)) + cubic((742,445),(742,536),(672,600),(546,600)) + [(406,600),(406,738)]
INNER = [(406,382),(406,504),(534,504)] + cubic((534,504),(599,504),(636,486),(636,444)) + cubic((636,444),(636,402),(599,382),(534,382))
TAIL = [(520,638),(646,638),(754,738),(612,738)]

def render(size):
    edge = size * 4
    image = Image.new('RGBA',(edge,edge))
    draw = ImageDraw.Draw(image)
    scale = edge / 1024
    mask=Image.new('L',(edge,edge));ImageDraw.Draw(mask).rounded_rectangle((64*scale,64*scale,960*scale,960*scale),radius=214*scale,fill=255)
    background=Image.new('RGBA',(edge,edge));gradient=ImageDraw.Draw(background)
    for y in range(edge):
        t=y/max(1,edge-1);gradient.line((0,y,edge,y),fill=(int(14-8*t),int(118-40*t),int(107-33*t),255))
    image.paste(background,(0,0),mask)
    draw=ImageDraw.Draw(image)
    draw.polygon([(x*scale,y*scale) for x,y in OUTER],fill='#ffffff')
    hole=Image.new('L',(edge,edge));ImageDraw.Draw(hole).polygon([(x*scale,y*scale) for x,y in INNER],fill=255)
    image.paste(background,(0,0),hole)
    draw=ImageDraw.Draw(image)
    draw.polygon([(x*scale,y*scale) for x,y in TAIL],fill='#9ce6c5')
    return image.resize((size,size),Image.Resampling.LANCZOS)

def svg(badge=False):
    bg = '<defs><linearGradient id="teal" x2="0" y2="1"><stop stop-color="#0e766b"/><stop offset="1" stop-color="#064e4a"/></linearGradient></defs><rect x="64" y="64" width="896" height="896" rx="214" fill="url(#teal)"/>' if badge else ''
    fill = '#ffffff' if badge else 'currentColor'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{bg}<path d="{PATH}" fill="{fill}" fill-rule="evenodd"/><path d="{TAIL_PATH}" fill="{"#9ce6c5" if badge else fill}"/></svg>'

def main():
    ICONS.mkdir(exist_ok=True);WEB.mkdir(exist_ok=True)
    for size,name in [(1024,'icon.png'),(512,'icon@512.png'),(256,'128x128@2x.png'),(128,'128x128.png'),(96,'96x96.png'),(64,'64x64.png'),(48,'48x48.png'),(40,'40x40.png'),(32,'32x32.png'),(24,'24x24.png'),(16,'16x16.png')]:
        render(size).save(ICONS/name)
    sizes=[16,20,24,32,40,48,64,96,256]
    blobs=[]
    for size in sizes:
        buf=io.BytesIO();render(size).save(buf,format='PNG');blobs.append(buf.getvalue())
    out=io.BytesIO();out.write(struct.pack('<HHH',0,1,len(sizes)));offset=6+16*len(sizes)
    for size,blob in zip(sizes,blobs):
        out.write(struct.pack('<BBBBHHII',size if size<256 else 0,size if size<256 else 0,0,0,1,32,len(blob),offset));offset+=len(blob)
    for blob in blobs:out.write(blob)
    (ICONS/'icon.ico').write_bytes(out.getvalue())
    (ICONS/'icon.svg').write_text(svg(True),encoding='utf-8')
    (WEB/'icon.svg').write_text(svg(True),encoding='utf-8')
    (WEB/'mark.svg').write_text(svg(),encoding='utf-8')
    sheet=Image.new('RGB',(760,320),'#f8faf9');draw=ImageDraw.Draw(sheet);x=20
    for size in [16,24,32,48,64,128,256]:
        im=render(size);sheet.paste(im,(x,28),im);draw.text((x,300),str(size),fill=INK);x+=size+22
    sheet.save(ICONS/'sizes.png')
    print('Relay icon assets generated')

if __name__=='__main__':main()
