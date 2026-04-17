"""Render the 6 axis views of a generated mesh and classify which
painted face ended up on each cube axis by dominant color."""
from __future__ import annotations
import os, sys, numpy as np, math
from PIL import Image
import trimesh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REFERENCE = {
    'F': ((220, 30, 30),   'FRONT red'),
    'B': ((40, 80, 230),   'BACK blue'),
    'R': ((245, 210, 130), 'RIGHT beige'),
    'L': ((240, 60, 220),  'LEFT magenta'),
    'T': ((50, 200, 70),   'TOP green'),
    'D': ((220, 60, 60),   'BOTTOM red border'),
}

def classify(rgb):
    r, g, b = rgb
    best = None; best_d = 1e18
    for name, ((rr, gg, bb), _desc) in REFERENCE.items():
        d = (r-rr)**2 + (g-gg)**2 + (b-bb)**2
        if d < best_d: best_d = d; best = name
    return best

def render_axis(mesh, cam_dir, up_dir, size=256):
    cam_pos = np.array(cam_dir, float)
    cam_pos = cam_pos / np.linalg.norm(cam_pos) * max(mesh.bounds[1] - mesh.bounds[0]) * 2.5
    forward = -cam_pos / np.linalg.norm(cam_pos)
    up0 = np.array(up_dir, float)
    right = np.cross(forward, up0); right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    R = np.vstack([right, up, -forward])
    t = -R @ cam_pos
    v_cam = (R @ mesh.vertices.T).T + t
    z = v_cam[:, 2]
    u2, v2 = v_cam[:, 0], v_cam[:, 1]
    ext = max(u2.max()-u2.min(), v2.max()-v2.min())
    scale = (size * 0.82) / ext
    cx = (u2.max()+u2.min())/2; cy = (v2.max()+v2.min())/2
    px = (u2 - cx) * scale + size/2
    py = size/2 - (v2 - cy) * scale

    try:
        tex = np.asarray(mesh.visual.material.baseColorTexture.convert('RGB'))
    except Exception:
        return np.zeros((size, size, 3), dtype=np.uint8)
    uvs = mesh.visual.uv
    faces = mesh.faces
    face_z = z[faces].mean(axis=1)
    order = np.argsort(face_z)[::-1]
    img = np.zeros((size, size, 3), dtype=np.uint8)
    depth = np.full((size, size), 1e18, float)
    aH, aW = tex.shape[:2]
    for i in order:
        f = faces[i]
        v0c, v1c, v2c = v_cam[f]
        n = np.cross(v1c - v0c, v2c - v0c)
        if n[2] < 1e-4: continue
        xs = px[f]; ys = py[f]
        xmin = max(0, int(xs.min())); xmax = min(size-1, int(xs.max()))
        ymin = max(0, int(ys.min())); ymax = min(size-1, int(ys.max()))
        if xmax<xmin or ymax<ymin: continue
        x0,x1,x2 = xs; y0,y1,y2 = ys
        denom = (y1-y2)*(x0-x2)+(x2-x1)*(y0-y2)
        if abs(denom)<1e-8: continue
        fz = z[f]; fuv = uvs[f]
        for yy in range(ymin, ymax+1):
            for xx in range(xmin, xmax+1):
                l0 = ((y1-y2)*(xx-x2)+(x2-x1)*(yy-y2))/denom
                l1 = ((y2-y0)*(xx-x2)+(x0-x2)*(yy-y2))/denom
                l2 = 1-l0-l1
                if l0>=0 and l1>=0 and l2>=0:
                    d = l0*fz[0]+l1*fz[1]+l2*fz[2]
                    if d < depth[yy,xx]:
                        depth[yy,xx] = d
                        u = l0*fuv[0][0]+l1*fuv[1][0]+l2*fuv[2][0]
                        v = l0*fuv[0][1]+l1*fuv[1][1]+l2*fuv[2][1]
                        ax = int(np.clip(u*(aW-1), 0, aW-1))
                        ay = int(np.clip((1-v)*(aH-1), 0, aH-1))
                        img[yy,xx] = tex[ay,ax]
    return img

def dominant_color(img):
    c0, c1 = int(img.shape[0]*0.3), int(img.shape[0]*0.7)
    sample = img[c0:c1, c0:c1].reshape(-1, 3)
    mask = sample.sum(1) > 30
    if not mask.any(): return (0,0,0)
    return tuple(int(x) for x in sample[mask].mean(0))

def main():
    mesh_path = sys.argv[1] if len(sys.argv) > 1 else 'meshes/_calibration/sf3d_projected.glb'
    m = trimesh.load(mesh_path, process=False)
    if hasattr(m, 'geometry'):
        g = list(m.geometry.values())[0]
    else:
        g = m
    print(f'Analyzing {mesh_path}: {len(g.vertices)} verts, {len(g.faces)} faces')

    axes = [
        ('Front(-Z)', (0,0,1),  (0,1,0), 'F'),
        ('Back(+Z)',  (0,0,-1), (0,1,0), 'B'),
        ('Right(+X)', (1,0,0),  (0,1,0), 'R'),
        ('Left(-X)',  (-1,0,0), (0,1,0), 'L'),
        ('Top(+Y)',   (0,1,0),  (0,0,1), 'T'),
        ('Bot(-Y)',   (0,-1,0), (0,0,-1), 'D'),
    ]
    out_dir = os.path.join(ROOT, 'images', '_calibration', 'ref_0_analysis')
    os.makedirs(out_dir, exist_ok=True)
    hits = 0
    for label, cam, up, expected in axes:
        img = render_axis(g, cam, up, size=256)
        Image.fromarray(img, 'RGB').save(os.path.join(out_dir, f'{label.replace("(","_").replace(")","").replace("-","m").replace("+","p")}.png'))
        col = dominant_color(img)
        got = classify(col)
        ok = 'OK' if got == expected else 'XX'
        print(f'  {label:12s} expected={expected} got={got} {ok} color={col}')
        if got == expected: hits += 1
    print(f'\nScore: {hits}/6 correct')
    print(f'Axis renders saved to {out_dir}')

if __name__ == '__main__':
    main()
