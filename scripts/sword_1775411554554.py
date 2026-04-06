import bpy
import bmesh
import math
from mathutils import Vector, Matrix, Euler
import random

# ============================================================
# SCENE SETUP - Clear everything
# ============================================================
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for mesh in bpy.data.meshes:
    bpy.data.meshes.remove(mesh)
for mat in bpy.data.materials:
    bpy.data.materials.remove(mat)
for img in bpy.data.images:
    bpy.data.images.remove(img)
for col in bpy.data.collections:
    bpy.data.collections.remove(col)

random.seed(42)

# ============================================================
# HELPER FUNCTIONS
# ============================================================
def recalc_normals(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

def shade_smooth_auto(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth()
    if hasattr(obj.data, 'use_auto_smooth'):
        obj.data.use_auto_smooth = True
        obj.data.auto_smooth_angle = math.radians(45)

def assign_material(obj, mat, faces=None):
    if mat.name not in [m.name for m in obj.data.materials]:
        obj.data.materials.append(mat)
    mat_idx = list(obj.data.materials).index(mat)
    if faces is None:
        for poly in obj.data.polygons:
            poly.material_index = mat_idx
    else:
        for fi in faces:
            if fi < len(obj.data.polygons):
                obj.data.polygons[fi].material_index = mat_idx

def deselect_all():
    bpy.ops.object.select_all(action='DESELECT')

# ============================================================
# MATERIALS
# ============================================================

# --- Mud/Adobe Wall Material ---
def create_mud_wall_material():
    mat = bpy.data.materials.new(name="MudWall")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # Color variation via noise
    noise1 = nodes.new('ShaderNodeTexNoise')
    noise1.location = (-400, 200)
    noise1.inputs['Scale'].default_value = 3.5
    noise1.inputs['Detail'].default_value = 8.0
    noise1.inputs['Roughness'].default_value = 0.7

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (-100, 200)
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = (0.25, 0.15, 0.08, 1.0)
    ramp.color_ramp.elements[1].position = 0.7
    ramp.color_ramp.elements[1].color = (0.4, 0.25, 0.12, 1.0)
    elem = ramp.color_ramp.elements.new(0.5)
    elem.color = (0.32, 0.2, 0.1, 1.0)

    links.new(noise1.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])

    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Specular IOR Level'].default_value = 0.3

    # Bump
    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -200)
    bump.inputs['Strength'].default_value = 0.4
    noise2 = nodes.new('ShaderNodeTexNoise')
    noise2.location = (-100, -200)
    noise2.inputs['Scale'].default_value = 12.0
    noise2.inputs['Detail'].default_value = 10.0
    links.new(noise2.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return mat

# --- Dark Wood Material ---
def create_wood_material():
    mat = bpy.data.materials.new(name="DarkWood")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    # Wood grain via wave texture
    wave = nodes.new('ShaderNodeTexWave')
    wave.location = (-400, 200)
    wave.inputs['Scale'].default_value = 5.0
    wave.inputs['Distortion'].default_value = 8.0
    wave.inputs['Detail'].default_value = 4.0
    wave.wave_type = 'BANDS'

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (-100, 200)
    ramp.color_ramp.elements[0].position = 0.2
    ramp.color_ramp.elements[0].color = (0.12, 0.06, 0.03, 1.0)
    ramp.color_ramp.elements[1].position = 0.8
    ramp.color_ramp.elements[1].color = (0.22, 0.12, 0.06, 1.0)

    links.new(wave.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])

    bsdf.inputs['Roughness'].default_value = 0.65
    bsdf.inputs['Metallic'].default_value = 0.0

    # Bump
    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -200)
    bump.inputs['Strength'].default_value = 0.3
    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (-100, -200)
    noise.inputs['Scale'].default_value = 20.0
    noise.inputs['Detail'].default_value = 6.0
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return mat

# --- Bone/Tusk Material ---
def create_bone_material():
    mat = bpy.data.materials.new(name="Bone")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (-300, 100)
    noise.inputs['Scale'].default_value = 8.0
    noise.inputs['Detail'].default_value = 5.0

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (0, 100)
    ramp.color_ramp.elements[0].color = (0.75, 0.68, 0.55, 1.0)
    ramp.color_ramp.elements[1].color = (0.9, 0.85, 0.72, 1.0)

    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])

    bsdf.inputs['Roughness'].default_value = 0.45
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Specular IOR Level'].default_value = 0.5

    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -200)
    bump.inputs['Strength'].default_value = 0.15
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return mat

# --- Rusty Metal Material ---
def create_rusty_metal_material():
    mat = bpy.data.materials.new(name="RustyMetal")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (-400, 200)
    noise.inputs['Scale'].default_value = 6.0
    noise.inputs['Detail'].default_value = 10.0

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (-100, 200)
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.15, 0.08, 0.04, 1.0)
    ramp.color_ramp.elements[1].position = 0.65
    ramp.color_ramp.elements[1].color = (0.5, 0.25, 0.1, 1.0)

    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])

    # Metallic variation
    ramp_met = nodes.new('ShaderNodeValToRGB')
    ramp_met.location = (-100, -100)
    ramp_met.color_ramp.elements[0].position = 0.4
    ramp_met.color_ramp.elements[0].color = (0.2, 0.2, 0.2, 1.0)
    ramp_met.color_ramp.elements[1].position = 0.6
    ramp_met.color_ramp.elements[1].color = (0.9, 0.9, 0.9, 1.0)
    links.new(noise.outputs['Fac'], ramp_met.inputs['Fac'])
    links.new(ramp_met.outputs['Color'], bsdf.inputs['Metallic'])

    bsdf.inputs['Roughness'].default_value = 0.7

    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -300)
    bump.inputs['Strength'].default_value = 0.5
    noise2 = nodes.new('ShaderNodeTexNoise')
    noise2.location = (-100, -300)
    noise2.inputs['Scale'].default_value = 25.0
    links.new(noise2.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return mat

# --- Leather/Hide Material ---
def create_hide_material():
    mat = bpy.data.materials.new(name="AnimalHide")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (-400, 200)
    noise.inputs['Scale'].default_value = 4.0
    noise.inputs['Detail'].default_value = 8.0

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (-100, 200)
    ramp.color_ramp.elements[0].color = (0.3, 0.18, 0.08, 1.0)
    ramp.color_ramp.elements[1].color = (0.45, 0.28, 0.14, 1.0)

    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])

    bsdf.inputs['Roughness'].default_value = 0.8
    bsdf.inputs['Metallic'].default_value = 0.0

    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -200)
    bump.inputs['Strength'].default_value = 0.35
    voronoi = nodes.new('ShaderNodeTexVoronoi')
    voronoi.location = (-100, -200)
    voronoi.inputs['Scale'].default_value = 15.0
    links.new(voronoi.outputs['Distance'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return mat

# --- Stone/Rock Material ---
def create_stone_material():
    mat = bpy.data.materials.new(name="Stone")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (-400, 200)
    noise.inputs['Scale'].default_value = 5.0
    noise.inputs['Detail'].default_value = 12.0
    noise.inputs['Roughness'].default_value = 0.6

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (-100, 200)
    ramp.color_ramp.elements[0].color = (0.2, 0.18, 0.16, 1.0)
    ramp.color_ramp.elements[1].color = (0.35, 0.32, 0.28, 1.0)

    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])

    bsdf.inputs['Roughness'].default_value = 0.9
    bsdf.inputs['Metallic'].default_value = 0.0

    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -200)
    bump.inputs['Strength'].default_value = 0.6
    noise2 = nodes.new('ShaderNodeTexNoise')
    noise2.location = (-100, -200)
    noise2.inputs['Scale'].default_value = 18.0
    noise2.inputs['Detail'].default_value = 8.0
    links.new(noise2.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return mat

# --- Rope Material ---
def create_rope_material():
    mat = bpy.data.materials.new(name="Rope")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    bsdf.inputs['Base Color'].default_value = (0.35, 0.28, 0.15, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.9
    bsdf.inputs['Metallic'].default_value = 0.0

    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -200)
    bump.inputs['Strength'].default_value = 0.4
    wave = nodes.new('ShaderNodeTexWave')
    wave.location = (-100, -200)
    wave.inputs['Scale'].default_value = 30.0
    wave.inputs['Distortion'].default_value = 2.0
    links.new(wave.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return mat

# Create all materials
mat_mud = create_mud_wall_material()
mat_wood = create_wood_material()
mat_bone = create_bone_material()
mat_metal = create_rusty_metal_material()
mat_hide = create_hide_material()
mat_stone = create_stone_material()
mat_rope = create_rope_material()

# ============================================================
# GEOMETRY - Orc House
# ============================================================

# --- FOUNDATION: Stone base ---
def create_stone_foundation():
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=12, radius=3.2, depth=0.6,
        location=(0, 0, 0.3)
    )
    base = bpy.context.active_object
    base.name = "Foundation"

    # Deform slightly for organic look
    bm = bmesh.new()
    bm.from_mesh(base.data)
    for v in bm.verts:
        if abs(v.co.z) < 0.25:
            noise_val = random.uniform(-0.15, 0.15)
            v.co.x += noise_val
            v.co.y += random.uniform(-0.15, 0.15)
    bm.to_mesh(base.data)
    bm.free()

    assign_material(base, mat_stone)
    recalc_normals(base)
    shade_smooth_auto(base)
    return base

# --- MAIN WALLS: Mud/adobe dome-like structure ---
def create_main_walls():
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=16, ring_count=10,
        radius=2.8, location=(0, 0, 1.8)
    )
    dome = bpy.context.active_object
    dome.name = "MainWalls"

    # Flatten bottom and shape into dome hut
    bm = bmesh.new()
    bm.from_mesh(dome.data)

    verts_to_remove = []
    for v in bm.verts:
        if v.co.z < -0.6:
            verts_to_remove.append(v)
        elif v.co.z < 0.5:
            # Widen the base
            factor = 1.0 + (0.5 - v.co.z) * 0.3
            v.co.x *= factor
            v.co.y *= factor
        # Add organic irregularity
        noise_val = random.uniform(-0.08, 0.08)
        v.co.x += noise_val
        v.co.y += random.uniform(-0.08, 0.08)
        v.co.z += random.uniform(-0.04, 0.04)

    # Remove bottom verts
    bmesh.ops.delete(bm, geom=verts_to_remove, context='VERTS')

    bm.to_mesh(dome.data)
    bm.free()

    # Add subdivision for smoothness
    mod_sub = dome.modifiers.new('Subdiv', 'SUBSURF')
    mod_sub.levels = 1
    mod_sub.render_levels = 2

    assign_material(dome, mat_mud)
    recalc_normals(dome)
    shade_smooth_auto(dome)
    return dome

# --- DOOR FRAME: Wooden arch ---
def create_door_frame():
    # Door opening carved look - two vertical posts + arch
    objects = []

    # Left post
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.65, -2.55, 1.5))
    left_post = bpy.context.active_object
    left_post.name = "DoorPostLeft"
    left_post.scale = (0.15, 0.2, 1.2)
    bpy.ops.object.transform_apply(scale=True)

    # Deform slightly
    bm = bmesh.new()
    bm.from_mesh(left_post.data)
    for v in bm.verts:
        v.co.x += random.uniform(-0.02, 0.02)
        v.co.y += random.uniform(-0.02, 0.02)
    bm.to_mesh(left_post.data)
    bm.free()

    assign_material(left_post, mat_wood)
    recalc_normals(left_post)
    shade_smooth_auto(left_post)
    objects.append(left_post)

    # Right post
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.65, -2.55, 1.5))
    right_post = bpy.context.active_object
    right_post.name = "DoorPostRight"
    right_post.scale = (0.15, 0.2, 1.2)
    bpy.ops.object.transform_apply(scale=True)

    bm = bmesh.new()
    bm.from_mesh(right_post.data)
    for v in bm.verts:
        v.co.x += random.uniform(-0.02, 0.02)
        v.co.y += random.uniform(-0.02, 0.02)
    bm.to_mesh(right_post.data)
    bm.free()

    assign_material(right_post, mat_wood)
    recalc_normals(right_post)
    shade_smooth_auto(right_post)
    objects.append(right_post)

    # Top beam (lintel) - slightly curved
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -2.55, 2.65))
    lintel = bpy.context.active_object
    lintel.name = "DoorLintel"
    lintel.scale = (0.85, 0.18, 0.12)
    bpy.ops.object.transform_apply(scale=True)

    bm = bmesh.new()
    bm.from_mesh(lintel.data)
    for v in bm.verts:
        # Slight arch
        v.co.z += 0.08 * (1.0 - abs(v.co.x) / 0.85)
        v.co.x += random.uniform(-0.02, 0.02)
    bm.to_mesh(lintel.data)
    bm.free()

    assign_material(lintel, mat_wood)
    recalc_normals(lintel)
    shade_smooth_auto(lintel)
    objects.append(lintel)

    return objects

# --- ROOF STRUCTURE: Wooden beams sticking out ---
def create_roof_beams():
    objects = []
    num_beams = 8
    for i in range(num_beams):
        angle = (2 * math.pi * i) / num_beams
        x = 2.2 * math.cos(angle)
        y = 2.2 * math.sin(angle)

        bpy.ops.mesh.primitive_cylinder_add(
            vertices=6, radius=0.08, depth=2.0,
            location=(x * 0.7, y * 0.7, 3.2)
        )
        beam = bpy.context.active_object
        beam.name = f"RoofBeam_{i}"

        # Tilt beams outward
        beam.rotation_euler = (
            -0.4 * math.sin(angle),
            0.4 * math.cos(angle),
            angle
        )

        # Add slight irregularity
        bm = bmesh.new()
        bm.from_mesh(beam.data)
        for v in bm.verts:
            v.co.x += random.uniform(-0.01, 0.01)
            v.co.y += random.uniform(-0.01, 0.01)
        bm.to_mesh(beam.data)
        bm.free()

        assign_material(beam, mat_wood)
        recalc_normals(beam)
        shade_smooth_auto(beam)
        objects.append(beam)

    return objects

# --- SKULL DECORATIONS above door ---
def create_skull(location, scale=1.0):
    # Skull = sphere + jaw
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=10, ring_count=6,
        radius=0.15 * scale, location=location
    )
    skull = bpy.context.active_object
    skull.name = "Skull"

    # Flatten slightly and shape
    bm = bmesh.new()
    bm.from_mesh(skull.data)
    for v in bm.verts:
        # Elongate front
        if v.co.y < 0:
            v.co.y *= 1.3
        # Flatten top slightly
        if v.co.z > 0.05 * scale:
            v.co.z *= 0.85
        # Eye sockets (push in vertices at approximate positions)
        if v.co.z > 0.02 * scale and abs(v.co.x) > 0.04 * scale and v.co.y < -0.05 * scale:
            v.co.y += 0.03 * scale
    bm.to_mesh(skull.data)
    bm.free()

    assign_material(skull, mat_bone)
    recalc_normals(skull)
    shade_smooth_auto(skull)

    # Jaw
    bpy.ops.mesh.primitive_cube_add(
        size=0.12 * scale,
        location=(location[0], location[1] - 0.06 * scale, location[2] - 0.1 * scale)
    )
    jaw = bpy.context.active_object
    jaw.name = "SkullJaw"
    jaw.scale = (1.0, 0.8, 0.4)
    bpy.ops.object.transform_apply(scale=True)

    assign_material(jaw, mat_bone)
    recalc_normals(jaw)
    shade_smooth_auto(jaw)

    return [skull, jaw]

# --- TUSKS/HORNS on sides of door ---
def create_tusk(location, rotation, scale=1.0):
    bpy.ops.mesh.primitive_cone_add(
        vertices=8, radius1=0.06 * scale, radius2=0.01 * scale,
        depth=0.8 * scale, location=location
    )
    tusk = bpy.context.active_object
    tusk.name = "Tusk"
    tusk.rotation_euler = rotation

    # Curve the tusk
    bm = bmesh.new()
    bm.from_mesh(tusk.data)
    for v in bm.verts:
        curve_amount = (v.co.z + 0.4 * scale) * 0.15
        v.co.x += curve_amount * curve_amount * 2.0
    bm.to_mesh(tusk.data)
    bm.free()

    assign_material(tusk, mat_bone)
    recalc_normals(tusk)
    shade_smooth_auto(tusk)
    return tusk

# --- HIDE/LEATHER DOOR FLAP ---
def create_door_flap():
    bpy.ops.mesh.primitive_plane_add(
        size=1, location=(0, -2.65, 1.6)
    )
    flap = bpy.context.active_object
    flap.name = "DoorFlap"
    flap.scale = (0.6, 0.05, 1.0)
    bpy.ops.object.transform_apply(scale=True)

    # Subdivide for draping effect
    bm = bmesh.new()
    bm.from_mesh(flap.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=4)
    for v in bm.verts:
        # Slight wave/drape effect
        v.co.y += math.sin(v.co.x * 5) * 0.03 + random.uniform(-0.02, 0.02)
        v.co.z += random.uniform(-0.02, 0.02)
    bm.to_mesh(flap.data)
    bm.free()

    assign_material(flap, mat_hide)
    recalc_normals(flap)
    shade_smooth_auto(flap)
    return flap

# --- CHIMNEY/SMOKE HOLE at top ---
def create_chimney():
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=8, radius=0.35, depth=0.8,
        location=(0.3, 0.3, 4.2)
    )
    chimney = bpy.context.active_object
    chimney.name = "Chimney"

    # Tilt slightly
    chimney.rotation_euler = (0.1, -0.05, 0.3)

    # Make it look rough
    bm = bmesh.new()
    bm.from_mesh(chimney.data)
    for v in bm.verts:
        v.co.x += random.uniform(-0.04, 0.04)
        v.co.y += random.uniform(-0.04, 0.04)
    bm.to_mesh(chimney.data)
    bm.free()

    assign_material(chimney, mat_mud)
    recalc_normals(chimney)
    shade_smooth_auto(chimney)
    return chimney

# --- SPIKES around the base ---
def create_spikes():
    objects = []
    num_spikes = 10
    for i in range(num_spikes):
        angle = (2 * math.pi * i) / num_spikes + random.uniform(-0.15, 0.15)
        r = 3.4 + random.uniform(-0.2, 0.2)
        x = r * math.cos(angle)
        y = r * math.sin(angle)

        # Skip spikes near the door
        if y < -2.5 and abs(x) < 1.5:
            continue

        height = random.uniform(0.8, 1.5)
        bpy.ops.mesh.primitive_cone_add(
            vertices=6, radius1=0.08, radius2=0.01,
            depth=height,
            location=(x, y, height / 2 + 0.1)
        )
        spike = bpy.context.active_object
        spike.name = f"Spike_{i}"

        # Slight tilt outward
        tilt = random.uniform(0.05, 0.15)
        spike.rotation_euler = (
            tilt * math.sin(angle),
            -tilt * math.cos(angle),
            random.uniform(-0.1, 0.1)
        )

        assign_material(spike, mat_wood)
        recalc_normals(spike)
        shade_smooth_auto(spike)
        objects.append(spike)

    return objects

# --- ROPE BINDINGS around beams ---
def create_rope_binding(location, radius=0.3, count=3):
    objects = []
    for i in range(count):
        bpy.ops.mesh.primitive_torus_add(
            major_radius=radius, minor_radius=0.015,
            major_segments=12, minor_segments=6,
            location=(location[0], location[1], location[2] + i * 0.06)
        )
        rope = bpy.context.active_object
        rope.name = f"Rope_{i}"
        rope.rotation_euler = (
            random.uniform(-0.1, 0.1),
            random.uniform(-0.1, 0.1),
            random.uniform(0, math.pi)
        )
        assign_material(rope, mat_rope)
        shade_smooth_auto(rope)
        objects.append(rope)
    return objects

# --- METAL BRACKETS on door ---
def create_metal_bracket(location):
    bpy.ops.mesh.primitive_cube_add(size=0.1, location=location)
    bracket = bpy.context.active_object
    bracket.name = "MetalBracket"
    bracket.scale = (0.3, 0.06, 0.06)
    bpy.ops.object.transform_apply(scale=True)

    # Add bevel
    mod = bracket.modifiers.new('Bevel', 'BEVEL')
    mod.width = 0.008
    mod.segments = 2

    assign_material(bracket, mat_metal)
    recalc_normals(bracket)
    shade_smooth_auto(bracket)
    return bracket

# --- SMALL WINDOW (just a hole marker with frame) ---
def create_window(location, rotation_z=0):
    objects = []

    # Window frame - rough wooden circle
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.3, minor_radius=0.05,
        major_segments=10, minor_segments=5,
        location=location
    )
    frame = bpy.context.active_object
    frame.name = "WindowFrame"
    frame.rotation_euler = (math.pi / 2, 0, rotation_z)

    bm = bmesh.new()
    bm.from_mesh(frame.data)
    for v in bm.verts:
        v.co.x += random.uniform(-0.015, 0.015)
        v.co.y += random.uniform(-0.015, 0.015)
    bm.to_mesh(frame.data)
    bm.free()

    assign_material(frame, mat_wood)
    recalc_normals(frame)
    shade_smooth_auto(frame)
    objects.append(frame)

    # Cross bars
    for rot in [0, math.pi / 2]:
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=5, radius=0.02, depth=0.55,
            location=location
        )
        bar = bpy.context.active_object
        bar.name = "WindowBar"
        bar.rotation_euler = (math.pi / 2, rot, rotation_z)
        assign_material(bar, mat_wood)
        shade_smooth_auto(bar)
        objects.append(bar)

    return objects

# --- GROUND PATCH ---
def create_ground():
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16, radius=5.0, depth=0.15,
        location=(0, 0, -0.02)
    )
    ground = bpy.context.active_object
    ground.name = "Ground"

    bm = bmesh.new()
    bm.from_mesh(ground.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2)
    for v in bm.verts:
        if abs(v.co.z) < 0.05:
            v.co.z += random.uniform(-0.03, 0.03)
    bm.to_mesh(ground.data)
    bm.free()

    # Dirt ground material
    mat_ground = bpy.data.materials.new(name="DirtGround")
    mat_ground.use_nodes = True
    nodes = mat_ground.node_tree.nodes
    links = mat_ground.node_tree.links
    nodes.clear()

    output = nodes.new('ShaderNodeOutputMaterial')
    output.location = (800, 0)
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (400, 0)
    links.new(bsdf.outputs['BSDF'], output.inputs['Surface'])

    noise = nodes.new('ShaderNodeTexNoise')
    noise.location = (-300, 100)
    noise.inputs['Scale'].default_value = 8.0
    noise.inputs['Detail'].default_value = 10.0

    ramp = nodes.new('ShaderNodeValToRGB')
    ramp.location = (0, 100)
    ramp.color_ramp.elements[0].color = (0.15, 0.1, 0.05, 1.0)
    ramp.color_ramp.elements[1].color = (0.25, 0.18, 0.08, 1.0)

    links.new(noise.outputs['Fac'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.95

    bump = nodes.new('ShaderNodeBump')
    bump.location = (200, -200)
    bump.inputs['Strength'].default_value = 0.3
    links.new(noise.outputs['Fac'], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])

    assign_material(ground, mat_ground)
    recalc_normals(ground)
    shade_smooth_auto(ground)
    return ground

# --- BANNER / WAR FLAG ---
def create_banner(location):
    objects = []

    # Pole
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=6, radius=0.04, depth=2.5,
        location=(location[0], location[1], location[2] + 1.25)
    )
    pole = bpy.context.active_object
    pole.name = "BannerPole"
    assign_material(pole, mat_wood)
    shade_smooth_auto(pole)
    objects.append(pole)

    # Flag cloth
    bpy.ops.mesh.primitive_plane_add(
        size=1,
        location=(location[0] + 0.35, location[1], location[2] + 2.1)
    )
    flag = bpy.context.active_object
    flag.name = "BannerFlag"
    flag.scale = (0.35, 0.05, 0.5)
    bpy.ops.object.transform_apply(scale=True)

    bm = bmesh.new()
    bm.from_mesh(flag.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=3)
    for v in bm.verts:
        # Wave effect
        v.co.y += math.sin(v.co.x * 8 + v.co.z * 3) * 0.04
    bm.to_mesh(flag.data)
    bm.free()

    # Red/dark banner material
    mat_banner = bpy.data.materials.new(name="BannerCloth")
    mat_banner.use_nodes = True
    bnodes = mat_banner.node_tree.nodes
    blinks = mat_banner.node_tree.links
    bnodes.clear()

    bout = bnodes.new('ShaderNodeOutputMaterial')
    bout.location = (400, 0)
    bbsdf = bnodes.new('ShaderNodeBsdfPrincipled')
    bbsdf.location = (0, 0)
    blinks.new(bbsdf.outputs['BSDF'], bout.inputs['Surface'])
    bbsdf.inputs['Base Color'].default_value = (0.5, 0.08, 0.05, 1.0)
    bbsdf.inputs['Roughness'].default_value = 0.8

    assign_material(flag, mat_banner)
    recalc_normals(flag)
    shade_smooth_auto(flag)
    objects.append(flag)

    # Skull on top of pole
    skull_objs = create_skull(
        (location[0], location[1], location[2] + 2.6), scale=0.8
    )
    objects.extend(skull_objs)

    return objects

# --- TORCH HOLDER ---
def create_torch(location):
    objects = []

    # Bracket
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=6, radius=0.03, depth=0.4,
        location=location
    )
    bracket = bpy.context.active_object
    bracket.name = "TorchBracket"
    bracket.rotation_euler = (0.3, 0, 0)
    assign_material(bracket, mat_metal)
    shade_smooth_auto(bracket)
    objects.append(bracket)

    # Torch stick
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=5, radius=0.025, depth=0.5,
        location=(location[0], location[1] - 0.15, location[2] + 0.2)
    )
    stick = bpy.context.active_object
    stick.name = "TorchStick"
    stick.rotation_euler = (0.2, 0, 0)
    assign_material(stick, mat_wood)
    shade_smooth_auto(stick)
    objects.append(stick)

    # Flame area (emissive sphere)
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=6, ring_count=4,
        radius=0.06,
        location=(location[0], location[1] - 0.22, location[2] + 0.45)
    )
    flame = bpy.context.active_object
    flame.name = "TorchFlame"

    mat_flame = bpy.data.materials.new(name="Flame")
    mat_flame.use_nodes = True
    fnodes = mat_flame.node_tree.nodes
    flinks = mat_flame.node_tree.links
    fnodes.clear()

    fout = fnodes.new('ShaderNodeOutputMaterial')
    fout.location = (400, 0)
    femit = fnodes.new('ShaderNodeBsdfPrincipled')
    femit.location = (0, 0)
    flinks.new(femit.outputs['BSDF'], fout.inputs['Surface'])
    femit.inputs['Base Color'].default_value = (1.0, 0.4, 0.05, 1.0)
    femit.inputs['Emission Color'].default_value = (1.0, 0.35, 0.02, 1.0)
    femit.inputs['Emission Strength'].default_value = 8.0

    assign_material(flame, mat_flame)
    shade_smooth_auto(flame)
    objects.append(flame)

    return objects

# ============================================================
# BUILD THE HOUSE
# ============================================================

all_objects = []

# Foundation
all_objects.append(create_stone_foundation())

# Main dome walls
all_objects.append(create_main_walls())

# Door frame
all_objects.extend(create_door_frame())

# Door flap
all_objects.append(create_door_flap())

# Roof beams
all_objects.extend(create_roof_beams())

# Chimney
all_objects.append(create_chimney())

# Skulls above door
skull1 = create_skull((0, -2.7, 2.9), scale=1.0)
all_objects.extend(skull1)
skull2 = create_skull((-0.45, -2.6, 2.95), scale=0.7)
all_objects.extend(skull2)
skull3 = create_skull((0.45, -2.6, 2.95), scale=0.7)
all_objects.extend(skull3)

# Tusks flanking the door
tusk_l = create_tusk((-1.1, -2.4, 1.8), (0, 0.6, -0.3), scale=1.2)
all_objects.append(tusk_l)
tusk_r = create_tusk((1.1, -2.4, 1.8), (0, -0.6, 0.3), scale=1.2)
all_objects.append(tusk_r)

# Spikes around base
all_objects.extend(create_spikes())

# Rope bindings on two front beams
rope1 = create_rope_binding((-0.65, -2.55, 2.5), radius=0.18, count=2)
all_objects.extend(rope1)
rope2 = create_rope_binding((0.65, -2.55, 2.5), radius=0.18, count=2)
all_objects.extend(rope2)

# Metal brackets on door frame
bracket1 = create_metal_bracket((-0.65, -2.7, 1.2))
all_objects.append(bracket1)
bracket2 = create_metal_bracket((0.65, -2.7, 1.2))
all_objects.append(bracket2)
bracket3 = create_metal_bracket((-0.65, -2.7, 1.8))
all_objects.append(bracket3)
bracket4 = create_metal_bracket((0.65, -2.7, 1.8))
all_objects.append(bracket4)

# Windows on sides
win1 = create_window((2.2, 0.5, 2.5), rotation_z=math.pi / 2)
all_objects.extend(win1)
win2 = create_window((-2.2, 0.5, 2.5), rotation_z=-math.pi / 2)
all_objects.extend(win2)

# Ground
all_objects.append(create_ground())

# Banner with skull
banner_objs = create_banner((3.5, -1.5, 0.1))
all_objects.extend(banner_objs)

# Torches flanking door
torch1 = create_torch((-1.3, -2.3, 2.0))
all_objects.extend(torch1)
torch2 = create_torch((1.3, -2.3, 2.0))
all_objects.extend(torch2)

# --- Additional small rocks around base ---
for i in range(6):
    angle = random.uniform(0, 2 * math.pi)
    r = random.uniform(3.5, 4.5)
    x = r * math.cos(angle)
    y = r * math.sin(angle)
    size = random.uniform(0.1, 0.25)

    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=6, ring_count=4,
        radius=size, location=(x, y, size * 0.5)
    )
    rock = bpy.context.active_object
    rock.name = f"Rock_{i}"
    rock.scale = (
        random.uniform(0.8, 1.3),
        random.uniform(0.8, 1.3),
        random.uniform(0.5, 0.9)
    )
    bpy.ops.object.transform_apply(scale=True)

    bm = bmesh.new()
    bm.from_mesh(rock.data)
    for v in bm.verts:
        v.co.x += random.uniform(-0.03, 0.03)
        v.co.y += random.uniform(-0.03, 0.03)
        v.co.z += random.uniform(-0.02, 0.02)
    bm.to_mesh(rock.data)
    bm.free()

    assign_material(rock, mat_stone)
    recalc_normals(rock)
    shade_smooth_auto(rock)

# ============================================================
# TRIANGLE BUDGET CHECK & DECIMATE
# ============================================================

# Apply all modifiers first to get accurate count
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

# Count triangles (each quad = 2 tris, each ngon = n-2 tris)
total_tris = 0
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        for poly in obj.data.polygons:
            total_tris += max(len(poly.vertices) - 2, 1)

print(f"Total triangles before decimate: {total_tris}")

if total_tris > 15000:
    target_ratio = 15000 / max(total_tris, 1)
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            obj_tris = sum(max(len(p.vertices) - 2, 1) for p in obj.data.polygons)
            if obj_tris > 50:  # Only decimate objects with significant geo
                bpy.context.view_layer.objects.active = obj
                obj.select_set(True)
                mod = obj.modifiers.new('Decimate', 'DECIMATE')
                mod.ratio = max(target_ratio, 0.1)
                try:
                    bpy.ops.object.modifier_apply(modifier='Decimate')
                except:
                    pass
                obj.select_set(False)

# Final count
total_tris = 0
for obj in bpy.data.objects:
    if obj.type == 'MESH':
        for poly in obj.data.polygons:
            total_tris += max(len(poly.vertices) - 2, 1)
print(f"Final triangle count: {total_tris}")

# ============================================================
# EXPORT
# ============================================================
output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/sword_1775411554554.glb"
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