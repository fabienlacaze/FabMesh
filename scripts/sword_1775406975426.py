import bpy
import bmesh
import math
from mathutils import Vector, Matrix, Euler

# ============================================================
# SCENE CLEANUP
# ============================================================
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for mesh in bpy.data.meshes:
    bpy.data.meshes.remove(mesh)
for mat in bpy.data.materials:
    bpy.data.materials.remove(mat)
for img in bpy.data.images:
    bpy.data.images.remove(img)
for node_group in bpy.data.node_groups:
    bpy.data.node_groups.remove(node_group)

# ============================================================
# HELPER FUNCTIONS
# ============================================================
def recalc_normals(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.editmode_toggle()
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.editmode_toggle()

def shade_smooth_auto(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth()
    if hasattr(obj.data, 'use_auto_smooth'):
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(35)

def assign_material_to_faces(obj, mat_index, face_indices):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    bpy.ops.object.mode_set(mode='OBJECT')
    for fi in face_indices:
        if fi < len(obj.data.polygons):
            obj.data.polygons[fi].material_index = mat_index
    bpy.ops.object.mode_set(mode='OBJECT')

# ============================================================
# MATERIALS
# ============================================================

# --- BLADE STEEL MATERIAL ---
mat_blade = bpy.data.materials.new(name="Blade_Steel")
mat_blade.use_nodes = True
nodes_b = mat_blade.node_tree.nodes
links_b = mat_blade.node_tree.links
nodes_b.clear()

out_b = nodes_b.new('ShaderNodeOutputMaterial')
out_b.location = (800, 0)
princ_b = nodes_b.new('ShaderNodeBsdfPrincipled')
princ_b.location = (400, 0)
princ_b.inputs['Base Color'].default_value = (0.55, 0.56, 0.58, 1.0)
princ_b.inputs['Metallic'].default_value = 0.95
princ_b.inputs['Roughness'].default_value = 0.18
princ_b.inputs['Specular IOR Level'].default_value = 0.8
links_b.new(princ_b.outputs['BSDF'], out_b.inputs['Surface'])

# Noise for subtle scratches / surface variation
tex_coord_b = nodes_b.new('ShaderNodeTexCoord')
tex_coord_b.location = (-600, 0)
mapping_b = nodes_b.new('ShaderNodeMapping')
mapping_b.location = (-400, 0)
mapping_b.inputs['Scale'].default_value = (50, 2, 50)
links_b.new(tex_coord_b.outputs['Object'], mapping_b.outputs[0].links[0].from_socket if mapping_b.outputs[0].links else mapping_b.inputs['Vector'])
links_b.new(tex_coord_b.outputs['Object'], mapping_b.inputs['Vector'])

noise_b = nodes_b.new('ShaderNodeTexNoise')
noise_b.location = (-200, 0)
noise_b.inputs['Scale'].default_value = 120.0
noise_b.inputs['Detail'].default_value = 8.0
noise_b.inputs['Roughness'].default_value = 0.7
links_b.new(mapping_b.outputs['Vector'], noise_b.inputs['Vector'])

bump_b = nodes_b.new('ShaderNodeBump')
bump_b.location = (200, -200)
bump_b.inputs['Strength'].default_value = 0.08
links_b.new(noise_b.outputs['Fac'], bump_b.inputs['Height'])
links_b.new(bump_b.outputs['Normal'], princ_b.inputs['Normal'])

# Color variation on blade
ramp_b = nodes_b.new('ShaderNodeValToRGB')
ramp_b.location = (0, 200)
ramp_b.color_ramp.elements[0].position = 0.4
ramp_b.color_ramp.elements[0].color = (0.50, 0.51, 0.53, 1.0)
ramp_b.color_ramp.elements[1].position = 0.6
ramp_b.color_ramp.elements[1].color = (0.62, 0.63, 0.65, 1.0)

noise_b2 = nodes_b.new('ShaderNodeTexNoise')
noise_b2.location = (-200, 200)
noise_b2.inputs['Scale'].default_value = 15.0
noise_b2.inputs['Detail'].default_value = 4.0
links_b.new(mapping_b.outputs['Vector'], noise_b2.inputs['Vector'])
links_b.new(noise_b2.outputs['Fac'], ramp_b.inputs['Fac'])
links_b.new(ramp_b.outputs['Color'], princ_b.inputs['Base Color'])


# --- GOLD GUARD MATERIAL ---
mat_gold = bpy.data.materials.new(name="Gold_Guard")
mat_gold.use_nodes = True
nodes_g = mat_gold.node_tree.nodes
links_g = mat_gold.node_tree.links
nodes_g.clear()

out_g = nodes_g.new('ShaderNodeOutputMaterial')
out_g.location = (800, 0)
princ_g = nodes_g.new('ShaderNodeBsdfPrincipled')
princ_g.location = (400, 0)
princ_g.inputs['Base Color'].default_value = (0.83, 0.65, 0.15, 1.0)
princ_g.inputs['Metallic'].default_value = 1.0
princ_g.inputs['Roughness'].default_value = 0.25
princ_g.inputs['Specular IOR Level'].default_value = 0.9
links_g.new(princ_g.outputs['BSDF'], out_g.inputs['Surface'])

tex_coord_g = nodes_g.new('ShaderNodeTexCoord')
tex_coord_g.location = (-600, 0)
mapping_g = nodes_g.new('ShaderNodeMapping')
mapping_g.location = (-400, 0)
mapping_g.inputs['Scale'].default_value = (30, 30, 30)
links_g.new(tex_coord_g.outputs['Object'], mapping_g.inputs['Vector'])

noise_g = nodes_g.new('ShaderNodeTexNoise')
noise_g.location = (-200, 0)
noise_g.inputs['Scale'].default_value = 60.0
noise_g.inputs['Detail'].default_value = 6.0
noise_g.inputs['Roughness'].default_value = 0.6
links_g.new(mapping_g.outputs['Vector'], noise_g.inputs['Vector'])

bump_g = nodes_g.new('ShaderNodeBump')
bump_g.location = (200, -200)
bump_g.inputs['Strength'].default_value = 0.05
links_g.new(noise_g.outputs['Fac'], bump_g.inputs['Height'])
links_g.new(bump_g.outputs['Normal'], princ_g.inputs['Normal'])

# Gold color variation
ramp_g = nodes_g.new('ShaderNodeValToRGB')
ramp_g.location = (0, 200)
ramp_g.color_ramp.elements[0].position = 0.35
ramp_g.color_ramp.elements[0].color = (0.75, 0.55, 0.10, 1.0)
ramp_g.color_ramp.elements[1].position = 0.65
ramp_g.color_ramp.elements[1].color = (0.90, 0.72, 0.20, 1.0)

noise_g2 = nodes_g.new('ShaderNodeTexNoise')
noise_g2.location = (-200, 200)
noise_g2.inputs['Scale'].default_value = 8.0
noise_g2.inputs['Detail'].default_value = 3.0
links_g.new(mapping_g.outputs['Vector'], noise_g2.inputs['Vector'])
links_g.new(noise_g2.outputs['Fac'], ramp_g.inputs['Fac'])
links_g.new(ramp_g.outputs['Color'], princ_g.inputs['Base Color'])


# --- LEATHER GRIP MATERIAL ---
mat_leather = bpy.data.materials.new(name="Leather_Grip")
mat_leather.use_nodes = True
nodes_l = mat_leather.node_tree.nodes
links_l = mat_leather.node_tree.links
nodes_l.clear()

out_l = nodes_l.new('ShaderNodeOutputMaterial')
out_l.location = (800, 0)
princ_l = nodes_l.new('ShaderNodeBsdfPrincipled')
princ_l.location = (400, 0)
princ_l.inputs['Base Color'].default_value = (0.15, 0.07, 0.03, 1.0)
princ_l.inputs['Metallic'].default_value = 0.0
princ_l.inputs['Roughness'].default_value = 0.75
princ_l.inputs['Specular IOR Level'].default_value = 0.3
links_l.new(princ_l.outputs['BSDF'], out_l.inputs['Surface'])

tex_coord_l = nodes_l.new('ShaderNodeTexCoord')
tex_coord_l.location = (-800, 0)
mapping_l = nodes_l.new('ShaderNodeMapping')
mapping_l.location = (-600, 0)
mapping_l.inputs['Scale'].default_value = (20, 20, 20)
links_l.new(tex_coord_l.outputs['Object'], mapping_l.inputs['Vector'])

# Leather grain bump
noise_l = nodes_l.new('ShaderNodeTexNoise')
noise_l.location = (-400, -100)
noise_l.inputs['Scale'].default_value = 80.0
noise_l.inputs['Detail'].default_value = 10.0
noise_l.inputs['Roughness'].default_value = 0.8
links_l.new(mapping_l.outputs['Vector'], noise_l.inputs['Vector'])

voronoi_l = nodes_l.new('ShaderNodeTexVoronoi')
voronoi_l.location = (-400, -300)
voronoi_l.inputs['Scale'].default_value = 50.0
links_l.new(mapping_l.outputs['Vector'], voronoi_l.inputs['Vector'])

mix_bump_l = nodes_l.new('ShaderNodeMixRGB')
mix_bump_l.location = (-200, -200)
mix_bump_l.blend_type = 'MIX'
mix_bump_l.inputs['Fac'].default_value = 0.5
links_l.new(noise_l.outputs['Fac'], mix_bump_l.inputs['Color1'])
links_l.new(voronoi_l.outputs['Distance'], mix_bump_l.inputs['Color2'])

bump_l = nodes_l.new('ShaderNodeBump')
bump_l.location = (200, -200)
bump_l.inputs['Strength'].default_value = 0.3
links_l.new(mix_bump_l.outputs['Color'], bump_l.inputs['Height'])
links_l.new(bump_l.outputs['Normal'], princ_l.inputs['Normal'])

# Leather color variation
ramp_l = nodes_l.new('ShaderNodeValToRGB')
ramp_l.location = (0, 200)
ramp_l.color_ramp.elements[0].position = 0.3
ramp_l.color_ramp.elements[0].color = (0.10, 0.05, 0.02, 1.0)
ramp_l.color_ramp.elements[1].position = 0.7
ramp_l.color_ramp.elements[1].color = (0.22, 0.12, 0.06, 1.0)

noise_l2 = nodes_l.new('ShaderNodeTexNoise')
noise_l2.location = (-400, 200)
noise_l2.inputs['Scale'].default_value = 12.0
noise_l2.inputs['Detail'].default_value = 5.0
links_l.new(mapping_l.outputs['Vector'], noise_l2.inputs['Vector'])
links_l.new(noise_l2.outputs['Fac'], ramp_l.inputs['Fac'])
links_l.new(ramp_l.outputs['Color'], princ_l.inputs['Base Color'])


# --- POMMEL DARK METAL MATERIAL ---
mat_pommel = bpy.data.materials.new(name="Pommel_Metal")
mat_pommel.use_nodes = True
nodes_p = mat_pommel.node_tree.nodes
links_p = mat_pommel.node_tree.links
nodes_p.clear()

out_p = nodes_p.new('ShaderNodeOutputMaterial')
out_p.location = (800, 0)
princ_p = nodes_p.new('ShaderNodeBsdfPrincipled')
princ_p.location = (400, 0)
princ_p.inputs['Base Color'].default_value = (0.25, 0.22, 0.18, 1.0)
princ_p.inputs['Metallic'].default_value = 0.9
princ_p.inputs['Roughness'].default_value = 0.4
links_p.new(princ_p.outputs['BSDF'], out_p.inputs['Surface'])

tex_coord_p = nodes_p.new('ShaderNodeTexCoord')
tex_coord_p.location = (-500, 0)
noise_p = nodes_p.new('ShaderNodeTexNoise')
noise_p.location = (-200, -100)
noise_p.inputs['Scale'].default_value = 40.0
noise_p.inputs['Detail'].default_value = 6.0
links_p.new(tex_coord_p.outputs['Object'], noise_p.inputs['Vector'])
bump_p = nodes_p.new('ShaderNodeBump')
bump_p.location = (200, -200)
bump_p.inputs['Strength'].default_value = 0.1
links_p.new(noise_p.outputs['Fac'], bump_p.inputs['Height'])
links_p.new(bump_p.outputs['Normal'], princ_p.inputs['Normal'])


# ============================================================
# BLADE GEOMETRY (bmesh)
# ============================================================
bm = bmesh.new()

# Blade profile - a long diamond cross-section tapered sword
blade_length = 0.75  # 75 cm blade
blade_width_base = 0.045  # 4.5 cm wide at base
blade_thickness = 0.006  # 6mm thick at thickest
num_segments = 20

# Create blade vertices as a series of cross-sections along Z
blade_sections = []
for i in range(num_segments + 1):
    t = i / num_segments
    z = t * blade_length

    # Width tapers linearly to a point
    if t < 0.85:
        width = blade_width_base * (1.0 - t * 0.4)
    else:
        # Faster taper to tip
        tt = (t - 0.85) / 0.15
        width = blade_width_base * 0.66 * (1.0 - tt)

    # Thickness also tapers
    thickness = blade_thickness * (1.0 - t * 0.5)

    # Fuller (blood groove) - slight indentation
    fuller_depth = 0.0
    if 0.05 < t < 0.7:
        fuller_depth = 0.001

    # Diamond cross section: 6 vertices per section
    # Top edge, right, bottom-right, bottom edge, bottom-left, left
    verts = []
    verts.append(bm.verts.new((0, thickness, z)))          # top center
    verts.append(bm.verts.new((width, 0, z)))               # right edge
    verts.append(bm.verts.new((0, -thickness, z)))          # bottom center
    verts.append(bm.verts.new((-width, 0, z)))              # left edge

    # Add fuller detail vertices
    if fuller_depth > 0:
        fw = width * 0.3
        verts.append(bm.verts.new((fw, thickness * 0.4 - fuller_depth, z)))   # right fuller top
        verts.append(bm.verts.new((fw, -thickness * 0.4 + fuller_depth, z)))  # right fuller bot
        verts.append(bm.verts.new((-fw, thickness * 0.4 - fuller_depth, z)))  # left fuller top
        verts.append(bm.verts.new((-fw, -thickness * 0.4 + fuller_depth, z))) # left fuller bot

    blade_sections.append(verts)

# Create faces between sections (simple diamond - 4 verts per section)
for i in range(num_segments):
    s0 = blade_sections[i][:4]
    s1 = blade_sections[i + 1][:4]
    n = len(s0)
    for j in range(n):
        j_next = (j + 1) % n
        try:
            bm.faces.new([s0[j], s0[j_next], s1[j_next], s1[j]])
        except:
            pass

# Cap bottom
try:
    bm.faces.new(blade_sections[0][:4])
except:
    pass

# Cap top (tip)
try:
    bm.faces.new(list(reversed(blade_sections[-1][:4])))
except:
    pass

bm.normal_update()

blade_mesh = bpy.data.meshes.new("Blade_Mesh")
bm.to_mesh(blade_mesh)
bm.free()

blade_obj = bpy.data.objects.new("Blade", blade_mesh)
bpy.context.collection.objects.link(blade_obj)
blade_obj.data.materials.append(mat_blade)

bpy.context.view_layer.objects.active = blade_obj
blade_obj.select_set(True)

# Subdivision surface for smoothness
mod_sub = blade_obj.modifiers.new("Subsurf", 'SUBSURF')
mod_sub.levels = 2
mod_sub.render_levels = 3

recalc_normals(blade_obj)
shade_smooth_auto(blade_obj)


# ============================================================
# BLADE EDGE BEVELS (ricasso area)
# ============================================================
# Add a short ricasso section (unsharpened part near guard)
bm_r = bmesh.new()
# Simple rectangular section
ricasso_length = 0.03
rw = blade_width_base * 0.9
rt = blade_thickness * 1.2

verts_bottom = [
    bm_r.verts.new((-rw, -rt, -ricasso_length)),
    bm_r.verts.new((rw, -rt, -ricasso_length)),
    bm_r.verts.new((rw, rt, -ricasso_length)),
    bm_r.verts.new((-rw, rt, -ricasso_length)),
]
verts_top = [
    bm_r.verts.new((-rw, -rt, 0)),
    bm_r.verts.new((rw, -rt, 0)),
    bm_r.verts.new((rw, rt, 0)),
    bm_r.verts.new((-rw, rt, 0)),
]

for j in range(4):
    j_next = (j + 1) % 4
    bm_r.faces.new([verts_bottom[j], verts_bottom[j_next], verts_top[j_next], verts_top[j]])

bm_r.faces.new(verts_bottom)
bm_r.faces.new(list(reversed(verts_top)))
bm_r.normal_update()

ricasso_mesh = bpy.data.meshes.new("Ricasso_Mesh")
bm_r.to_mesh(ricasso_mesh)
bm_r.free()

ricasso_obj = bpy.data.objects.new("Ricasso", ricasso_mesh)
bpy.context.collection.objects.link(ricasso_obj)
ricasso_obj.data.materials.append(mat_blade)

bpy.context.view_layer.objects.active = ricasso_obj
ricasso_obj.select_set(True)

mod_bev_r = ricasso_obj.modifiers.new("Bevel", 'BEVEL')
mod_bev_r.width = 0.003
mod_bev_r.segments = 3

mod_sub_r = ricasso_obj.modifiers.new("Subsurf", 'SUBSURF')
mod_sub_r.levels = 2
mod_sub_r.render_levels = 3

recalc_normals(ricasso_obj)
shade_smooth_auto(ricasso_obj)


# ============================================================
# CROSS GUARD (golden)
# ============================================================
bm_g = bmesh.new()

guard_half_length = 0.09  # 18 cm total width
guard_height = 0.022
guard_depth = 0.018

# Main guard bar - octagonal cross section extruded along X
num_guard_segs = 16
guard_sections = []

for i in range(num_guard_segs + 1):
    t = i / num_guard_segs
    x = -guard_half_length + t * 2 * guard_half_length

    # Slight taper towards ends and decorative swelling
    scale = 1.0 - 0.3 * abs(2 * t - 1) ** 2
    # Decorative flare at ends
    if abs(2 * t - 1) > 0.85:
        end_t = (abs(2 * t - 1) - 0.85) / 0.15
        scale += 0.2 * end_t

    h = guard_height * scale
    d = guard_depth * scale

    # Octagonal cross section
    section_verts = []
    for k in range(8):
        angle = k * math.pi / 4 + math.pi / 8
        py = math.cos(angle) * h
        pz = math.sin(angle) * d
        section_verts.append(bm_g.verts.new((x, py, pz)))

    guard_sections.append(section_verts)

# Connect sections
for i in range(num_guard_segs):
    s0 = guard_sections[i]
    s1 = guard_sections[i + 1]
    for j in range(8):
        j_next = (j + 1) % 8
        try:
            bm_g.faces.new([s0[j], s0[j_next], s1[j_next], s1[j]])
        except:
            pass

# Cap ends
try:
    bm_g.faces.new(guard_sections[0])
except:
    pass
try:
    bm_g.faces.new(list(reversed(guard_sections[-1])))
except:
    pass

bm_g.normal_update()

guard_mesh = bpy.data.meshes.new("Guard_Mesh")
bm_g.to_mesh(guard_mesh)
bm_g.free()

guard_obj = bpy.data.objects.new("Guard", guard_mesh)
bpy.context.collection.objects.link(guard_obj)
guard_obj.location = (0, 0, -ricasso_length)
guard_obj.data.materials.append(mat_gold)

bpy.context.view_layer.objects.active = guard_obj
guard_obj.select_set(True)

mod_sub_g = guard_obj.modifiers.new("Subsurf", 'SUBSURF')
mod_sub_g.levels = 2
mod_sub_g.render_levels = 3

mod_bev_g = guard_obj.modifiers.new("Bevel", 'BEVEL')
mod_bev_g.width = 0.002
mod_bev_g.segments = 2

recalc_normals(guard_obj)
shade_smooth_auto(guard_obj)


# ============================================================
# GUARD DECORATIVE QUILLONS (curved ends)
# ============================================================
for side in [1, -1]:
    bm_q = bmesh.new()
    quillon_segs = 10
    quillon_length = 0.025
    quillon_sections = []

    for i in range(quillon_segs + 1):
        t = i / quillon_segs
        # Curve slightly downward (toward pommel)
        x = side * (guard_half_length + t * quillon_length)
        z = -t * 0.015 * t  # slight downward curve
        r = 0.008 * (1.0 - 0.4 * t)  # taper

        section_verts = []
        for k in range(8):
            angle = k * math.pi / 4
            py = math.cos(angle) * r
            pz = z + math.sin(angle) * r
            section_verts.append(bm_q.verts.new((x, py, pz)))
        quillon_sections.append(section_verts)

    for i in range(quillon_segs):
        s0 = quillon_sections[i]
        s1 = quillon_sections[i + 1]
        for j in range(8):
            j_next = (j + 1) % 8
            try:
                bm_q.faces.new([s0[j], s0[j_next], s1[j_next], s1[j]])
            except:
                pass

    # Cap tip with a small sphere-like dome
    tip = bm_q.verts.new((side * (guard_half_length + quillon_length + 0.005), 0, -quillon_length * 0.015 * quillon_segs))
    last_s = quillon_sections[-1]
    for j in range(8):
        j_next = (j + 1) % 8
        try:
            bm_q.faces.new([last_s[j], last_s[j_next], tip])
        except:
            pass

    try:
        bm_q.faces.new(quillon_sections[0])
    except:
        pass

    bm_q.normal_update()

    q_mesh = bpy.data.meshes.new(f"Quillon_{side}_Mesh")
    bm_q.to_mesh(q_mesh)
    bm_q.free()

    q_obj = bpy.data.objects.new(f"Quillon_{side}", q_mesh)
    bpy.context.collection.objects.link(q_obj)
    q_obj.location = (0, 0, -ricasso_length)
    q_obj.data.materials.append(mat_gold)

    bpy.context.view_layer.objects.active = q_obj
    q_obj.select_set(True)

    mod_sub_q = q_obj.modifiers.new("Subsurf", 'SUBSURF')
    mod_sub_q.levels = 2
    mod_sub_q.render_levels = 3

    recalc_normals(q_obj)
    shade_smooth_auto(q_obj)


# ============================================================
# GUARD RAIN GUARD (small decorative plate above guard)
# ============================================================
bm_rg = bmesh.new()
rg_verts_b = []
rg_verts_t = []
rg_sides = 16
rg_radius = 0.02
rg_height = 0.008

for i in range(rg_sides):
    angle = i * 2 * math.pi / rg_sides
    # Slightly elongated along X
    rx = rg_radius * 1.5 * math.cos(angle)
    ry = rg_radius * math.sin(angle)
    rg_verts_b.append(bm_rg.verts.new((rx, ry, 0)))
    rg_verts_t.append(bm_rg.verts.new((rx * 0.7, ry * 0.7, rg_height)))

for i in range(rg_sides):
    i_next = (i + 1) % rg_sides
    try:
        bm_rg.faces.new([rg_verts_b[i], rg_verts_b[i_next], rg_verts_t[i_next], rg_verts_t[i]])
    except:
        pass

try:
    bm_rg.faces.new(list(reversed(rg_verts_b)))
except:
    pass
try:
    bm_rg.faces.new(rg_verts_t)
except:
    pass

bm_rg.normal_update()
rg_mesh = bpy.data.meshes.new("RainGuard_Mesh")
bm_rg.to_mesh(rg_mesh)
bm_rg.free()

rg_obj = bpy.data.objects.new("RainGuard", rg_mesh)
bpy.context.collection.objects.link(rg_obj)
rg_obj.location = (0, 0, -ricasso_length + 0.002)
rg_obj.data.materials.append(mat_gold)

bpy.context.view_layer.objects.active = rg_obj
rg_obj.select_set(True)

mod_sub_rg = rg_obj.modifiers.new("Subsurf", 'SUBSURF')
mod_sub_rg.levels = 2
mod_sub_rg.render_levels = 3

recalc_normals(rg_obj)
shade_smooth_auto(rg_obj)


# ============================================================
# GRIP / HANDLE (leather wrapped)
# ============================================================
grip_length = 0.14  # 14 cm
grip_radius = 0.014
grip_segments = 24
grip_rings = 30

bm_h = bmesh.new()
grip_sections = []

for i in range(grip_rings + 1):
    t = i / grip_rings
    z = -ricasso_length - t * grip_length

    # Slight ergonomic swelling in the middle
    swell = 1.0 + 0.12 * math.sin(t * math.pi)
    r = grip_radius * swell

    # Leather wrap bumps
    wrap_bump = 0.001 * math.sin(t * grip_rings * math.pi)

    section_verts = []
    for j in range(grip_segments):
        angle = j * 2 * math.pi / grip_segments
        px = math.cos(angle) * (r + wrap_bump)
        py = math.sin(angle) * (r + wrap_bump)

        # Add leather wrap ridge - diagonal pattern
        wrap_angle = angle + t * math.pi * 8
        ridge = 0.0015 * max(0, math.sin(wrap_angle * 4))
        px += math.cos(angle) * ridge
        py += math.sin(angle) * ridge

        section_verts.append(bm_h.verts.new((px, py, z)))

    grip_sections.append(section_verts)

for i in range(grip_rings):
    s0 = grip_sections[i]
    s1 = grip_sections[i + 1]
    for j in range(grip_segments):
        j_next = (j + 1) % grip_segments
        try:
            bm_h.faces.new([s0[j], s0[j_next], s1[j_next], s1[j]])
        except:
            pass

# Cap top and bottom
try:
    bm_h.faces.new(grip_sections[0])
except:
    pass
try:
    bm_h.faces.new(list(reversed(grip_sections[-1])))
except:
    pass

bm_h.normal_update()

grip_mesh = bpy.data.meshes.new("Grip_Mesh")
bm_h.to_mesh(grip_mesh)
bm_h.free()

grip_obj = bpy.data.objects.new("Grip", grip_mesh)
bpy.context.collection.objects.link(grip_obj)
grip_obj.data.materials.append(mat_leather)

bpy.context.view_layer.objects.active = grip_obj
grip_obj.select_set(True)

mod_sub_h = grip_obj.modifiers.new("Subsurf", 'SUBSURF')
mod_sub_h.levels = 2
mod_sub_h.render_levels = 3

recalc_normals(grip_obj)
shade_smooth_auto(grip_obj)


# ============================================================
# LEATHER WRAP BANDS (decorative bindings)
# ============================================================
num_bands = 7
for bi in range(num_bands):
    t = (bi + 0.5) / num_bands
    z_band = -ricasso_length - t * grip_length

    bm_band = bmesh.new()
    band_height = 0.003
    band_r_inner = grip_radius * (1.0 + 0.12 * math.sin(t * math.pi)) + 0.001
    band_r_outer = band_r_inner + 0.002
    band_segs = 20

    inner_b = []
    outer_b = []
    inner_t = []
    outer_t = []

    for j in range(band_segs):
        angle = j * 2 * math.pi / band_segs
        cx = math.cos(angle)
        cy = math.sin(angle)
        inner_b.append(bm_band.verts.new((cx * band_r_inner, cy * band_r_inner, -band_height / 2)))
        outer_b.append(bm_band.verts.new((cx * band_r_outer, cy * band_r_outer, -band_height / 2)))
        inner_t.append(bm_band.verts.new((cx * band_r_inner, cy * band_r_inner, band_height / 2)))
        outer_t.append(bm_band.verts.new((cx * band_r_outer, cy * band_r_outer, band_height / 2)))

    for j in range(band_segs):
        jn = (j + 1) % band_segs
        # Outer face
        try:
            bm_band.faces.new([outer_b[j], outer_b[jn], outer_t[jn], outer_t[j]])
        except:
            pass
        # Inner face
        try:
            bm_band.faces.new([inner_t[j], inner_t[jn], inner_b[jn], inner_b[j]])
        except:
            pass
        # Top face
        try:
            bm_band.faces.new([inner_t[j], outer_t[j], outer_t[jn], inner_t[jn]])
        except:
            pass
        # Bottom face
        try:
            bm_band.faces.new([outer_b[j], inner_b[j], inner_b[jn], outer_b[jn]])
        except:
            pass

    bm_band.normal_update()
    band_mesh = bpy.data.meshes.new(f"Band_{bi}_Mesh")
    bm_band.to_mesh(band_mesh)
    bm_band.free()

    band_obj = bpy.data.objects.new(f"Band_{bi}", band_mesh)
    bpy.context.collection.objects.link(band_obj)
    band_obj.location = (0, 0, z_band)
    band_obj.data.materials.append(mat_leather)

    bpy.context.view_layer.objects.active = band_obj
    band_obj.select_set(True)

    mod_sub_band = band_obj.modifiers.new("Subsurf", 'SUBSURF')
    mod_sub_band.levels = 1
    mod_sub_band.render_levels = 2

    recalc_normals(band_obj)
    shade_smooth_auto(band_obj)


# ============================================================
# POMMEL (ornate, with gold accents)
# ============================================================
pommel_z = -ricasso_length - grip_length
pommel_radius = 0.022
pommel_height = 0.035

bm_pm = bmesh.new()
pommel_rings = 16
pommel_segs = 20
pommel_sections = []

for i in range(pommel_rings + 1):
    t = i / pommel_rings
    z = pommel_z - t * pommel_height

    # Shape: sphere-like with a flat top and slight teardrop
    if t < 0.15:
        r = pommel_radius * 0.6 + pommel_radius * 0.4 * (t / 0.15)
    elif t < 0.5:
        # Bulging middle
        tt = (t - 0.15) / 0.35
        r = pommel_radius * (1.0 + 0.15 * math.sin(tt * math.pi))
    elif t < 0.85:
        tt = (t - 0.5) / 0.35
        r = pommel_radius * (1.15 - 0.65 * tt)
    else:
        tt = (t - 0.85) / 0.15
        r = pommel_radius * 0.5 * (1.0 - tt * 0.7)

    # Add subtle faceting for decorative effect
    section_verts = []
    for j in range(pommel_segs):
        angle = j * 2 * math.pi / pommel_segs
        # Subtle 8-sided faceting
        facet = 1.0 + 0.03 * math.cos(8 * angle)
        px = math.cos(angle) * r * facet
        py = math.sin(angle) * r * facet
        section_verts.append(bm_pm.verts.new((px, py, z)))

    pommel_sections.append(section_verts)

for i in range(pommel_rings):
    s0 = pommel_sections[i]
    s1 = pommel_sections[i + 1]
    for j in range(pommel_segs):
        j_next = (j + 1) % pommel_segs
        try:
            bm_pm.faces.new([s0[j], s0[j_next], s1[j_next], s1[j]])
        except:
            pass

# Cap top
try:
    bm_pm.faces.new(pommel_sections[0])
except:
    pass

# Cap bottom with center point
bottom_center = bm_pm.verts.new((0, 0, pommel_z - pommel_height - 0.003))
last_pm = pommel_sections[-1]
for j in range(pommel_segs):
    j_next = (j + 1) % pommel_segs
    try:
        bm_pm.faces.new([last_pm[j], last_pm[j_next], bottom_center])
    except:
        pass

bm_pm.normal_update()

pommel_mesh = bpy.data.meshes.new("Pommel_Mesh")
bm_pm.to_mesh(pommel_mesh)
bm_pm.free()

pommel_obj = bpy.data.objects.new("Pommel", pommel_mesh)
bpy.context.collection.objects.link(pommel_obj)
pommel_obj.data.materials.append(mat_pommel)
pommel_obj.data.materials.append(mat_gold)

bpy.context.view_layer.objects.active = pommel_obj
pommel_obj.select_set(True)

mod_sub_pm = pommel_obj.modifiers.new("Subsurf", 'SUBSURF')
mod_sub_pm.levels = 2
mod_sub_pm.render_levels = 3

mod_bev_pm = pommel_obj.modifiers.new("Bevel", 'BEVEL')
mod_bev_pm.width = 0.001
mod_bev_pm.segments = 2

recalc_normals(pommel_obj)
shade_smooth_auto(pommel_obj)

# Assign gold material to decorative ring area on pommel
bpy.context.view_layer.objects.active = pommel_obj
bpy.ops.object.mode_set(mode='OBJECT')
total_pommel_faces = len(pommel_obj.data.polygons)
# Gold band in the middle region
gold_faces = []
for fi in range(total_pommel_faces):
    face = pommel_obj.data.polygons[fi]
    center_z = face.center[2]
    relative_z = (center_z - pommel_z) / (-pommel_height)
    if 0.3 < relative_z < 0.55:
        gold_faces.append(fi)

assign_material_to_faces(pommel_obj, 1, gold_faces)


# ============================================================
# POMMEL CAP (golden finial)
# ============================================================
bpy.ops.mesh.primitive_uv_sphere_add(
    radius=0.008,
    segments=16,
    ring_count=12,
    location=(0, 0, pommel_z - pommel_height - 0.003)
)
cap_obj = bpy.context.active_object
cap_obj.name = "PommelCap"
cap_obj.data.materials.append(mat_gold)

mod_sub_cap = cap_obj.modifiers.new("Subsurf", 'SUBSURF')
mod_sub_cap.levels = 1
mod_sub_cap.render_levels = 2

shade_smooth_auto(cap_obj)


# ============================================================
# GUARD DECORATIVE RING (gold ring where guard meets grip)
# ============================================================
for z_offset in [0, -0.005]:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=grip_radius + 0.005,
        minor_radius=0.003,
        major_segments=32,
        minor_segments=12,
        location=(0, 0, -ricasso_length + z_offset)
    )
    ring_obj = bpy.context.active_object
    ring_obj.name = f"GuardRing_{z_offset}"
    ring_obj.data.materials.append(mat_gold)
    shade_smooth_auto(ring_obj)


# ============================================================
# GRIP FERRULE (gold ring at top of grip near guard)
# ============================================================
bpy.ops.mesh.primitive_torus_add(
    major_radius=grip_radius + 0.004,
    minor_radius=0.0025,
    major_segments=32,
    minor_segments=10,
    location=(0, 0, -ricasso_length - 0.01)
)
ferrule_top = bpy.context.active_object
ferrule_top.name = "Ferrule_Top"
ferrule_top.data.materials.append(mat_gold)
shade_smooth_auto(ferrule_top)

# Bottom ferrule near pommel
bpy.ops.mesh.primitive_torus_add(
    major_radius=grip_radius + 0.004,
    minor_radius=0.0025,
    major_segments=32,
    minor_segments=10,
    location=(0, 0, pommel_z + 0.005)
)
ferrule_bot = bpy.context.active_object
ferrule_bot.name = "Ferrule_Bottom"
ferrule_bot.data.materials.append(mat_gold)
shade_smooth_auto(ferrule_bot)


# ============================================================
# TANG (hidden metal core inside grip - visible slightly)
# ============================================================
bm_tang = bmesh.new()
tang_length = grip_length + 0.02
tang_width = 0.008
tang_thick = 0.004

v0 = bm_tang.verts.new((-tang_width, -tang_thick, -ricasso_length))
v1 = bm_tang.verts.new((tang_width, -tang_thick, -ricasso_length))
v2 = bm_tang.verts.new((tang_width, tang_thick, -ricasso_length))
v3 = bm_tang.verts.new((-tang_width, tang_thick, -ricasso_length))
v4 = bm_tang.verts.new((-tang_width * 0.7, -tang_thick * 0.7, -ricasso_length - tang_length))
v5 = bm_tang.verts.new((tang_width * 0.7, -tang_thick * 0.7, -ricasso_length - tang_length))
v6 = bm_tang.verts.new((tang_width * 0.7, tang_thick * 0.7, -ricasso_length - tang_length))
v7 = bm_tang.verts.new((-tang_width * 0.7, tang_thick * 0.7, -ricasso_length - tang_length))

tang_faces = [
    [v0, v1, v5, v4], [v1, v2, v6, v5],
    [v2, v3, v7, v6], [v3, v0, v4, v7],
    [v3, v2, v1, v0], [v4, v5, v6, v7]
]
for f in tang_faces:
    try:
        bm_tang.faces.new(f)
    except:
        pass

bm_tang.normal_update()
tang_mesh = bpy.data.meshes.new("Tang_Mesh")
bm_tang.to_mesh(tang_mesh)
bm_tang.free()

tang_obj = bpy.data.objects.new("Tang", tang_mesh)
bpy.context.collection.objects.link(tang_obj)
tang_obj.data.materials.append(mat_blade)

bpy.context.view_layer.objects.active = tang_obj
tang_obj.select_set(True)
recalc_normals(tang_obj)
shade_smooth_auto(tang_obj)


# ============================================================
# FINAL CLEANUP - Apply modifiers for export
# ============================================================
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for mod in obj.modifiers:
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except:
                pass
        obj.select_set(False)


# ============================================================
# SELECT ALL AND JOIN FOR CLEAN EXPORT
# ============================================================
bpy.ops.object.select_all(action='DESELECT')
mesh_objects = [obj for obj in bpy.data.objects if obj.type == 'MESH']
for obj in mesh_objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = mesh_objects[0]


# ============================================================
# EXPORT
# ============================================================
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775406975426.glb"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt)
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")