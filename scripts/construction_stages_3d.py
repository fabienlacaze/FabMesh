"""Fabricate REAL 3D construction-stage meshes from one finished GLB (Manor Lords
style, auto-manufactured). For each stage p: solid = bottom p% of the mesh (face
filter → texture preserved) + cap; timber FRAME above the build line (beams along
the building's own cross-section contour); modular SCAFFOLD cage around the
footprint. Args: <mesh.glb> <out_dir> <N>. Writes stage_0..N-1.glb (last = exact copy).
Pure geometry (no GPU)."""
import sys, os, shutil
import numpy as np
import trimesh

SRC, OUT = sys.argv[1], sys.argv[2]
N = int(sys.argv[3]) if len(sys.argv) > 3 else 5
os.makedirs(OUT, exist_ok=True)

WOOD = [140, 98, 55, 255]      # beams (default)
WOOD2 = [168, 124, 76, 255]    # scaffold poles/planks (default)
# Varied wood shades → beams don't look uniform; picked deterministically by
# position so the SAME beam keeps the SAME shade across stages.
WOODS = [[140, 98, 55, 255], [168, 124, 76, 255], [122, 86, 48, 255],
         [152, 110, 66, 255], [176, 136, 88, 255]]
def wood(p):
    return WOODS[int(abs(p[0] * 73.7 + p[1] * 179.3 + p[2] * 283.1)) % len(WOODS)]

scene = trimesh.load(SRC)
if isinstance(scene, trimesh.Scene):
    geoms = list(scene.geometry.values())
    mesh = geoms[0] if len(geoms) == 1 else trimesh.util.concatenate(geoms)
else:
    mesh = scene
mesh = mesh.copy()
minB, maxB = mesh.bounds
minY, maxY = float(minB[1]), float(maxB[1])
H = maxY - minY
cx, cz = (minB[0] + maxB[0]) / 2, (minB[2] + maxB[2]) / 2
SX, SZ = (maxB[0] - minB[0]), (maxB[2] - minB[2])
R = float(max(SX, SZ))
POLE_R = 0.006 * R             # beam/pole radius

def beam(p0, p1, r=None, color=None, shape='cyl'):
    """Wooden beam between two 3D points. shape='cyl' (round pole, scaffolding) or
    'box' (square timber, building frame) — shape variety reads more real."""
    p0, p1 = np.asarray(p0, float), np.asarray(p1, float)
    L = np.linalg.norm(p1 - p0)
    if L < 1e-6: return None
    rr = (r or POLE_R)
    if shape == 'box':
        c = trimesh.creation.box(extents=[rr * 2.2, rr * 2.2, L])
        c.apply_translation([0, 0, L / 2])
    else:
        c = trimesh.creation.cylinder(radius=rr, height=L, sections=8)
        c.apply_translation([0, 0, L / 2])
    c.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], (p1 - p0) / L))
    c.apply_translation(p0)
    c.visual = trimesh.visual.ColorVisuals(c, face_colors=(color or wood(p0)))
    return c

# Cap colour matched to the BUILDING's own material (mean texture colour) so the
# cut cross-section reads as the same stone/wood as the building.
CAPC = [120, 112, 100, 255]
try:
    _mat = mesh.visual.material
    _img = getattr(_mat, 'baseColorTexture', None) or getattr(_mat, 'image', None)
    if _img is not None:
        _avg = np.asarray(_img.convert('RGB').resize((64, 64))).reshape(-1, 3).mean(0)
        CAPC = [int(_avg[0] * 0.9), int(_avg[1] * 0.9), int(_avg[2] * 0.9), 255]
except Exception:
    pass

# STYLE-MATCHED wood texture (user request): generate ONE wood-planks texture in the
# BUILDING'S OWN style via RealVisXL + IP-Adapter (style ref = the mesh's baked
# texture → realistic building gives realistic wood, Minecraft-style gives blocky
# wood). Optional: falls back to flat wood colours if GPU/models unavailable.
WOOD_TEX = None
try:
    if _img is not None and os.environ.get('FABMESH_NO_WOOD_TEX') != '1':
        import torch
        from diffusers import StableDiffusionXLPipeline, AutoencoderKL
        _vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
        _pipe = StableDiffusionXLPipeline.from_pretrained(
            "SG161222/RealVisXL_V4.0", vae=_vae, torch_dtype=torch.float16)
        _pipe.load_ip_adapter("h94/IP-Adapter", subfolder="sdxl_models",
                              weight_name="ip-adapter_sdxl.safetensors")
        # LOW IP scale: transfer the mesh's RENDERING STYLE (realistic grain vs
        # blocky Minecraft vs hand-painted strokes) but NOT its palette — the wood
        # must stay wood (user: pas la couleur, le style).
        _pipe.set_ip_adapter_scale(0.3)
        _pipe.enable_model_cpu_offload()
        WOOD_TEX = _pipe(
            prompt="seamless tiling texture of brown wooden planks and timber beams, warm brown wood grain, flat top-down surface",
            negative_prompt="grey, gray, metal, steel, stone, building, wall, window, blurry, text",
            ip_adapter_image=_img.convert('RGB').resize((1024, 1024)),
            width=1024, height=1024, num_inference_steps=20, guidance_scale=5.5,
            generator=torch.Generator("cuda").manual_seed(7)).images[0]
        # HUE LOCK: keep the generated detail/style (value channel) but clamp the
        # colour to warm wood so it can never drift to grey/metal.
        _hsv = np.asarray(WOOD_TEX.convert('HSV')).copy()
        _hsv[..., 0] = 16                                     # wood hue
        _hsv[..., 1] = np.clip(_hsv[..., 1].astype(int) + 70, 70, 190).astype(np.uint8)
        from PIL import Image as _PILImage
        WOOD_TEX = _PILImage.fromarray(_hsv, 'HSV').convert('RGB')
        WOOD_TEX.save(os.path.join(OUT, "_wood_tex.png"))
        del _pipe, _vae
        torch.cuda.empty_cache()
        print("[3d] style-matched wood texture generated", flush=True)
except Exception as e:
    print(f"[3d] wood texture skipped ({e}) — flat colours fallback", flush=True)

def texturize(wood_parts):
    """Map the style-matched wood texture PER PIECE, grain running ALONG each
    piece's dominant axis (PCA) — poles get vertical grain, beams/planks get grain
    along their length (realistic), with a per-piece offset so pieces sample
    different plank rows. Fallback: keep flat colours."""
    ms = [p for p in wood_parts if isinstance(p, trimesh.Trimesh) and len(p.faces)]
    if WOOD_TEX is None or not ms:
        return wood_parts
    mat = trimesh.visual.material.PBRMaterial(
        baseColorTexture=WOOD_TEX, metallicFactor=0.0, roughnessFactor=0.9)
    s = max(0.5 * R, 1e-6)
    out = []
    for p in ms:
        c = p.vertices.mean(0)
        v = p.vertices - c
        try:
            _w, E = np.linalg.eigh(np.cov(v.T))
            a1, a2 = E[:, -1], E[:, -2]              # dominant + secondary axes
        except Exception:
            a1, a2 = np.array([0., 1., 0.]), np.array([1., 0., 0.])
        voff = (abs(c[0] * 57.1 + c[1] * 93.7 + c[2] * 131.3)) % 1.0
        uv = np.column_stack([(v @ a1) / s, (v @ a2) / s + voff])
        q = p.copy()
        q.visual = trimesh.visual.TextureVisuals(uv=uv, material=mat)
        out.append(q)
    try:
        return [trimesh.util.concatenate(out)]        # one textured mesh (shared material)
    except Exception:
        return out

def contour_at(y):
    """Building cross-section outline points at height y (world XZ), ordered."""
    try:
        sec = mesh.section(plane_origin=[0, y, 0], plane_normal=[0, 1, 0])
        if sec is None: return []
        loops = []
        for ent in sec.discrete:                     # list of (n,3) polylines
            if len(ent) >= 3: loops.append(np.asarray(ent))
        return loops
    except Exception:
        return []

def frame_at(yline, frameH):
    """Timber frame of the NEXT storey: vertical studs along the section contour
    at yline, plus a top ring beam following the contour → looks like the building's
    own frame rising before the walls (fabricated Manor Lords frame stage)."""
    parts = []
    loops = contour_at(max(minY + 0.02 * H, yline - 0.01 * H))
    step = 0.09 * R                                  # stud spacing
    for loop in loops:
        # resample the loop at ~step spacing
        d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(loop, axis=0), axis=1))]
        if d[-1] < step: continue
        studs = []
        for t in np.arange(0, d[-1], step):
            i = np.searchsorted(d, t); i = min(i, len(loop) - 1)
            p = loop[i]
            b = beam([p[0], yline, p[2]], [p[0], yline + frameH, p[2]], shape='box')
            if b is not None: parts.append(b); studs.append(p)
        # diagonal braces between alternate studs (timber-frame look)
        for k in range(0, len(studs) - 1, 2):
            a, c2 = studs[k], studs[k + 1]
            b = beam([a[0], yline, a[2]], [c2[0], yline + frameH, c2[2]],
                     r=POLE_R * 0.7, shape='box')
            if b is not None: parts.append(b)
        # top ring following the contour (coarse)
        for i in range(0, len(loop) - 1, max(1, len(loop) // 60)):
            j = min(i + max(1, len(loop) // 60), len(loop) - 1)
            b = beam([loop[i][0], yline + frameH, loop[i][2]],
                     [loop[j][0], yline + frameH, loop[j][2]], r=POLE_R * 0.8, shape='box')
            if b is not None: parts.append(b)
    return parts

def formwork_at(yline):
    """CLOSED formwork band (coffrage) wrapping the building at the build line:
    continuous vertical wooden panels following the contour all around (offset
    hugging the wall), with top/bottom rails — hides the raw cut/junction between
    the sliced shell and the frame, on every side."""
    parts = []
    # Band spans BELOW the line enough to swallow the triangle-jagged cut edge
    # (face filter keeps faces under yline → jags extend downward), and a bit above.
    y0, y1 = yline - 0.06 * H, yline + 0.035 * H
    off = 0.012 * R; thick = POLE_R * 1.6
    step = 0.045 * R
    loops = contour_at(max(minY + 0.02 * H, yline - 0.04 * H))
    for loop in loops:
        c = loop.mean(axis=0)
        d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(loop, axis=0), axis=1))]
        if d[-1] < step * 2: continue
        pts = []
        for t in np.arange(0, d[-1], step):
            i = min(int(np.searchsorted(d, t)), len(loop) - 1)
            p = loop[i]
            n = p - c; n[1] = 0
            nl = np.linalg.norm(n)
            q = p + (n / nl) * off if nl > 1e-6 else p
            pts.append([q[0], q[2]])
        n2 = len(pts)
        if n2 < 3: continue
        for k in range(n2):
            a = pts[k]; b = pts[(k + 1) % n2]
            seg = np.hypot(b[0] - a[0], b[1] - a[1])
            if seg < 1e-6 or seg > step * 3: continue
            panel = trimesh.creation.box(extents=[seg * 1.08, y1 - y0, thick])
            ang = np.arctan2(b[1] - a[1], b[0] - a[0])
            panel.apply_transform(trimesh.transformations.rotation_matrix(-ang, [0, 1, 0]))
            panel.apply_translation([(a[0] + b[0]) / 2, (y0 + y1) / 2, (a[1] + b[1]) / 2])
            panel.visual = trimesh.visual.ColorVisuals(panel, face_colors=wood([a[0], y0, a[1]]))
            parts.append(panel)
            for yw in (y0 + POLE_R, y1 - POLE_R):     # walers (rails haut/bas)
                bb = beam([a[0], yw, a[1]], [b[0], yw, b[1]], r=POLE_R * 0.7)
                if bb is not None: parts.append(bb)
    return parts

def scaffold_to(topY):
    """PHYSICALLY-CREDIBLE scaffold: standards follow the BUILDING'S OWN footprint
    contour (offset ~0.5m out, hugging towers/facades — not a distant AABB box);
    ledgers/planks/braces are PER-BAY between neighbouring posts (real timber
    lengths, nothing spans a whole facade); base pads under every post."""
    parts = []
    bay = max(0.12 * R, 1e-3); lift = 0.16 * H
    top = min(topY + 0.10 * H, maxY + 0.05 * H)
    off = 0.045 * R                                  # working gap facade↔scaffold
    loops = contour_at(minY + 0.06 * H)
    def area(l):                                     # shoelace on XZ
        x, z = l[:, 0], l[:, 2]
        return 0.5 * abs(np.dot(x, np.roll(z, 1)) - np.dot(z, np.roll(x, 1)))
    loops = [l for l in loops if area(l) > 0.02 * SX * SZ]
    posts_pts = []
    for loop in loops:
        c = loop.mean(axis=0)
        d = np.r_[0, np.cumsum(np.linalg.norm(np.diff(loop, axis=0), axis=1))]
        if d[-1] < bay: continue
        ring = []
        for t in np.arange(0, d[-1] - bay * 0.4, bay):
            i = min(int(np.searchsorted(d, t)), len(loop) - 1)
            p = loop[i]
            n = p - c; n[1] = 0
            nl = np.linalg.norm(n)
            if nl < 1e-6: continue
            q = p + (n / nl) * off
            ring.append([q[0], q[2]])
        if len(ring) >= 3: posts_pts.append(ring)
    if not posts_pts:                                # fallback: AABB ring
        m = off
        x0, x1, z0, z1 = minB[0] - m, maxB[0] + m, minB[2] - m, maxB[2] + m
        ring = [[x, z0] for x in np.arange(x0, x1, bay)] + [[x1, z] for z in np.arange(z0, z1, bay)] + \
               [[x, z1] for x in np.arange(x1, x0, -bay)] + [[x0, z] for z in np.arange(z1, z0, -bay)]
        posts_pts = [ring]
    lifts = np.arange(minY + lift, top, lift)
    for ring in posts_pts:
        n = len(ring)
        for k, (x, z) in enumerate(ring):
            b = beam([x, minY, z], [x, top, z])       # standard (varied shade)
            if b is not None: parts.append(b)
            pad = trimesh.creation.box(extents=[POLE_R * 5, POLE_R * 1.6, POLE_R * 5])
            pad.apply_translation([x, minY + POLE_R * 0.8, z])
            pad.visual = trimesh.visual.ColorVisuals(pad, face_colors=WOOD)
            parts.append(pad)                          # base pad (sits on ground)
        for y in lifts:
            for k in range(n):
                a = ring[k]; bq = ring[(k + 1) % n]
                seg = np.hypot(bq[0] - a[0], bq[1] - a[1])
                if seg > bay * 2.6: continue           # never span a huge gap
                bb = beam([a[0], y, a[1]], [bq[0], y, bq[1]], r=POLE_R * 0.8, color=WOOD2)
                if bb is not None: parts.append(bb)    # ledger per bay
                # walk plank per bay (box laid on the ledger)
                mx, mz = (a[0] + bq[0]) / 2, (a[1] + bq[1]) / 2
                pl = trimesh.creation.box(extents=[seg * 0.98, POLE_R * 1.1, POLE_R * 4.5])
                ang = np.arctan2(bq[1] - a[1], bq[0] - a[0])
                Rm = trimesh.transformations.rotation_matrix(-ang, [0, 1, 0])
                pl.apply_transform(Rm); pl.apply_translation([mx, y + POLE_R, mz])
                pl.visual = trimesh.visual.ColorVisuals(pl, face_colors=wood([mx, y, mz]))
                parts.append(pl)
                if (k % 2) == 0:                       # diagonal brace, alternate bays
                    yb = min(y + lift, top)
                    d1 = beam([a[0], y, a[1]], [bq[0], yb, bq[1]], r=POLE_R * 0.6)
                    if d1 is not None: parts.append(d1)
    return parts

for i in range(N):
    p = 1.0 if N <= 1 else i / (N - 1)
    out = os.path.join(OUT, f"stage_{i}.glb")
    if i == N - 1:
        shutil.copyfile(SRC, out); print(f"[3d] stage {i} (final copy)", flush=True); continue
    keep = max(p, 0.06)
    yline = minY + keep * H
    # SOLID: faces entirely below the build line (texture preserved: no new verts)
    solid = mesh.copy()
    vy = solid.vertices[:, 1]
    below = (vy[solid.faces].max(axis=1) <= yline)
    solid.update_faces(below)
    solid.remove_unreferenced_vertices()
    parts = [solid] if len(solid.faces) else []
    woodp = []                                        # all wooden parts (→ texturize)
    # CAP the cut so the hollow shell doesn't show an empty box
    try:
        sec = mesh.section(plane_origin=[0, yline, 0], plane_normal=[0, 1, 0])
        if sec is not None:
            planar, T = sec.to_2D()
            v2, f2 = planar.triangulate()
            if len(f2):
                cap = trimesh.Trimesh(np.column_stack([v2, np.zeros(len(v2))]), f2)
                cap.apply_transform(T)
                cap.visual = trimesh.visual.ColorVisuals(cap, face_colors=CAPC)
                parts.append(cap)
    except Exception:
        pass
    # WOODEN WORK FLOOR over the cut (user request): plank boards covering the real
    # cross-section → the hollow interior is never visible, and it reads as the
    # construction deck. Boards are clipped to the building outline (even-odd test),
    # so nothing overhangs past towers/walls.
    try:
        from matplotlib.path import Path as MplPath
        loops2 = contour_at(yline)
        paths2 = [MplPath(np.column_stack([l[:, 0], l[:, 2]])) for l in loops2 if len(l) >= 3]
        if paths2:
            plankW = max(0.018 * R, 1e-4)
            xs_all = np.arange(minB[0], maxB[0], plankW * 0.5)
            for zc in np.arange(minB[2], maxB[2], plankW):
                pts2 = np.column_stack([xs_all, np.full(len(xs_all), zc)])
                cnt = np.zeros(len(pts2), int)
                for pa in paths2: cnt += pa.contains_points(pts2).astype(int)
                inside = (cnt % 2) == 1
                k2 = 0
                while k2 < len(inside):
                    if inside[k2]:
                        j2 = k2
                        while j2 + 1 < len(inside) and inside[j2 + 1]: j2 += 1
                        xa, xb = xs_all[k2], xs_all[j2]
                        if xb - xa > plankW:
                            bd = trimesh.creation.box(extents=[xb - xa, POLE_R * 1.2, plankW * 0.92])
                            bd.apply_translation([(xa + xb) / 2, yline + POLE_R * 0.7, zc + plankW / 2])
                            bd.visual = trimesh.visual.ColorVisuals(bd, face_colors=wood([xa, yline, zc]))
                            woodp.append(bd)
                        k2 = j2 + 1
                    else:
                        k2 += 1
    except Exception:
        pass
    woodp += formwork_at(yline)                       # coffrage: hides the jagged cut
    woodp += frame_at(yline, frameH=0.10 * H)        # the rising timber frame
    woodp += scaffold_to(yline)                       # scaffold up to the build level
    parts += texturize(woodp)                         # style-matched wood (or flat fallback)
    out_scene = trimesh.Scene()
    for k, g in enumerate(parts): out_scene.add_geometry(g, node_name=f"g{k}")
    out_scene.export(out)
    print(f"[3d] stage {i} (keep={keep:.2f}, solid_faces={len(solid.faces)})", flush=True)
print("DONE", OUT, flush=True)
