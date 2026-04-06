import bpy
import bmesh
import math
from mathutils import Vector

# Clear the scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for mesh in bpy.data.meshes:
    bpy.data.meshes.remove(mesh)
for mat in bpy.data.materials:
    bpy.data.materials.remove(mat)
for col in bpy.data.collections:
    bpy.data.collections.remove(col)

# ============================================================
# MATERIALS
# ============================================================

def make_material(name, base_color, roughness=0.8, specular=0.3):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = base_color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Specular IOR Level"].default_value = specular
    return mat

mat_stone_wall = make_material("StoneWall", (0.35, 0.30, 0.25, 1.0), roughness=0.95, specular=0.15)
mat_wood_dark = make_material("WoodDark", (0.22, 0.13, 0.07, 1.0), roughness=0.85, specular=0.2)
mat_wood_beam = make_material("WoodBeam", (0.30, 0.18, 0.09, 1.0), roughness=0.80, specular=0.25)
mat_thatch_roof = make_material("ThatchRoof", (0.35, 0.25, 0.12, 1.0), roughness=0.98, specular=0.05)
mat_hay = make_material("Hay", (0.55, 0.42, 0.18, 1.0), roughness=0.95, specular=0.05)
mat_dirt_floor = make_material("DirtFloor", (0.25, 0.18, 0.12, 1.0), roughness=1.0, specular=0.05)
mat_chimney_stone = make_material("ChimneyStone", (0.28, 0.24, 0.22, 1.0), roughness=0.95, specular=0.1)
mat_chimney_inside = make_material("ChimneyInside", (0.05, 0.04, 0.03, 1.0), roughness=1.0, specular=0.0)

# ============================================================
# HELPER FUNCTIONS
# ============================================================

def create_box(name, location, dimensions, material, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (dimensions[0], dimensions[1], dimensions[2])
    obj.rotation_euler = rotation
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return obj

def create_cylinder(name, location, radius, depth, material, rotation=(0, 0, 0), vertices=32):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, vertices=vertices, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return obj

def recalc_normals(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')

# ============================================================
# STABLE DIMENSIONS
# ============================================================
stable_width = 8.0    # X
stable_depth = 10.0   # Y
wall_height = 3.5
wall_thickness = 0.4
roof_overhang = 0.8
roof_peak_height = 3.0

# ============================================================
# FLOOR
# ============================================================
floor = create_box("Floor", (0, 0, -0.05), (stable_width + 1.0, stable_depth + 1.0, 0.1), mat_dirt_floor)

# ============================================================
# WALLS
# ============================================================

# Back wall (solid)
back_wall = create_box("BackWall", (0, -stable_depth / 2, wall_height / 2),
                       (stable_width, wall_thickness, wall_height), mat_stone_wall)

# Left wall
left_wall = create_box("LeftWall", (-stable_width / 2, 0, wall_height / 2),
                       (wall_thickness, stable_depth, wall_height), mat_stone_wall)

# Right wall
right_wall = create_box("RightWall", (stable_width / 2, 0, wall_height / 2),
                        (wall_thickness, stable_depth, wall_height), mat_stone_wall)

# Front wall - left section
front_left = create_box("FrontWallLeft", (-stable_width / 2 + 1.0, stable_depth / 2, wall_height / 2),
                        (2.0, wall_thickness, wall_height), mat_stone_wall)

# Front wall - right section
front_right = create_box("FrontWallRight", (stable_width / 2 - 1.0, stable_depth / 2, wall_height / 2),
                         (2.0, wall_thickness, wall_height), mat_stone_wall)

# Front wall - top section (above door)
front_top = create_box("FrontWallTop", (0, stable_depth / 2, wall_height - 0.5),
                       (stable_width - 4.0, wall_thickness, 1.0), mat_stone_wall)

# ============================================================
# GABLE WALLS (triangular sections above walls)
# ============================================================

def create_gable(name, y_pos, material):
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bm = bmesh.new()
    hw = stable_width / 2
    h = wall_height
    peak = wall_height + roof_peak_height
    v1 = bm.verts.new((-hw, y_pos, h))
    v2 = bm.verts.new((hw, y_pos, h))
    v3 = bm.verts.new((0, y_pos, peak))
    # Front face
    bm.faces.new([v1, v2, v3])
    # Add thickness
    v4 = bm.verts.new((-hw, y_pos - wall_thickness * (1 if y_pos < 0 else -1), h))
    v5 = bm.verts.new((hw, y_pos - wall_thickness * (1 if y_pos < 0 else -1), h))
    v6 = bm.verts.new((0, y_pos - wall_thickness * (1 if y_pos < 0 else -1), peak))
    bm.faces.new([v6, v5, v4])
    # Side faces
    bm.faces.new([v1, v3, v6, v4])
    bm.faces.new([v3, v2, v5, v6])
    bm.faces.new([v1, v4, v5, v2])
    bm.to_mesh(mesh)
    bm.free()
    obj.data.materials.append(material)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.shade_smooth()
    recalc_normals(obj)
    return obj

gable_back = create_gable("GableBack", -stable_depth / 2, mat_stone_wall)
gable_front = create_gable("GableFront", stable_depth / 2, mat_stone_wall)

# ============================================================
# ROOF (two sloped planes)
# ============================================================

def create_roof_panel(name, location, size, rotation, material):
    bpy.ops.mesh.primitive_plane_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    # Add solidify modifier for thickness
    mod = obj.modifiers.new(name="Solidify", type='SOLIDIFY')
    mod.thickness = 0.15
    mod.offset = -1
    bpy.ops.object.modifier_apply(modifier="Solidify")
    obj.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    recalc_normals(obj)
    return obj

roof_angle = math.atan2(roof_peak_height, stable_width / 2)
roof_length = math.sqrt((stable_width / 2) ** 2 + roof_peak_height ** 2) + roof_overhang
roof_depth_total = stable_depth + roof_overhang * 2

# Left roof panel
left_roof_x = -stable_width / 4
left_roof_z = wall_height + roof_peak_height / 2
left_roof = create_roof_panel("RoofLeft",
    (left_roof_x, 0, left_roof_z),
    (roof_length, roof_depth_total / 2, 1),
    (0, roof_angle, 0),
    mat_thatch_roof)

# Right roof panel
right_roof_x = stable_width / 4
right_roof = create_roof_panel("RoofRight",
    (right_roof_x, 0, left_roof_z),
    (roof_length, roof_depth_total / 2, 1),
    (0, -roof_angle, 0),
    mat_thatch_roof)

# Roof ridge beam
ridge_beam = create_box("RidgeBeam",
    (0, 0, wall_height + roof_peak_height + 0.05),
    (0.15, roof_depth_total, 0.15), mat_wood_dark)

# ============================================================
# WOODEN BEAMS / TIMBER FRAME
# ============================================================

# Vertical corner posts
post_positions = [
    (-stable_width / 2 + 0.1, -stable_depth / 2 + 0.1),
    (stable_width / 2 - 0.1, -stable_depth / 2 + 0.1),
    (-stable_width / 2 + 0.1, stable_depth / 2 - 0.1),
    (stable_width / 2 - 0.1, stable_depth / 2 - 0.1),
]

for i, (px, py) in enumerate(post_positions):
    post = create_box(f"CornerPost_{i}", (px, py, wall_height / 2),
                      (0.25, 0.25, wall_height), mat_wood_beam)

# Horizontal beams along top of walls
# Front beam
create_box("BeamFront", (0, stable_depth / 2, wall_height + 0.1),
           (stable_width + 0.3, 0.2, 0.2), mat_wood_beam)
# Back beam
create_box("BeamBack", (0, -stable_depth / 2, wall_height + 0.1),
           (stable_width + 0.3, 0.2, 0.2), mat_wood_beam)
# Left beam
create_box("BeamLeft", (-stable_width / 2, 0, wall_height + 0.1),
           (0.2, stable_depth + 0.3, 0.2), mat_wood_beam)
# Right beam
create_box("BeamRight", (stable_width / 2, 0, wall_height + 0.1),
           (0.2, stable_depth + 0.3, 0.2), mat_wood_beam)

# Cross beams on walls (decorative half-timber)
for y_offset in [-stable_depth / 2, stable_depth / 2]:
    for x_off in [-1.5, 1.5]:
        create_box(f"CrossBeam_{y_offset}_{x_off}",
                   (x_off, y_offset, wall_height * 0.6),
                   (0.12, 0.05, wall_height * 0.5), mat_wood_beam)

# Horizontal mid-beam on side walls
for x_offset in [-stable_width / 2, stable_width / 2]:
    create_box(f"MidBeamSide_{x_offset}",
               (x_offset, 0, wall_height * 0.55),
               (0.05, stable_depth * 0.8, 0.15), mat_wood_beam)

# ============================================================
# DOOR FRAME
# ============================================================
door_width = 3.0
door_height = 2.8

# Door frame posts
create_box("DoorFrameLeft", (-door_width / 2, stable_depth / 2, door_height / 2),
           (0.2, 0.5, door_height), mat_wood_dark)
create_box("DoorFrameRight", (door_width / 2, stable_depth / 2, door_height / 2),
           (0.2, 0.5, door_height), mat_wood_dark)
# Door lintel
create_box("DoorLintel", (0, stable_depth / 2, door_height),
           (door_width + 0.4, 0.5, 0.25), mat_wood_dark)

# Door panels (slightly open)
create_box("DoorLeft", (-door_width / 4 - 0.3, stable_depth / 2 + 0.3, door_height / 2 - 0.1),
           (door_width / 2 - 0.1, 0.08, door_height - 0.3), mat_wood_dark,
           rotation=(0, 0, 0.3))
create_box("DoorRight", (door_width / 4 + 0.3, stable_depth / 2 + 0.3, door_height / 2 - 0.1),
           (door_width / 2 - 0.1, 0.08, door_height - 0.3), mat_wood_dark,
           rotation=(0, 0, -0.3))

# ============================================================
# WINDOWS (small medieval stable windows)
# ============================================================

def create_window(name, location, material_frame):
    # Window hole frame
    create_box(f"{name}_Frame", location, (0.8, 0.5, 1.0), material_frame)
    # Window bars
    for dx in [-0.15, 0.15]:
        create_box(f"{name}_BarV_{dx}", (location[0] + dx, location[1], location[2]),
                   (0.04, 0.05, 0.9), mat_wood_dark)
    create_box(f"{name}_BarH", location, (0.7, 0.05, 0.04), mat_wood_dark)

# Windows on left wall
create_window("WindowLeft1", (-stable_width / 2 - 0.05, -1.5, wall_height * 0.6), mat_wood_beam)
create_window("WindowLeft2", (-stable_width / 2 - 0.05, 1.5, wall_height * 0.6), mat_wood_beam)

# Window on right wall
create_window("WindowRight1", (stable_width / 2 + 0.05, 0, wall_height * 0.6), mat_wood_beam)

# ============================================================
# STALL DIVIDERS (inside the stable)
# ============================================================

for i in range(3):
    y_pos = -stable_depth / 2 + 2.5 + i * 2.5
    # Lower wall divider
    create_box(f"StallDivider_{i}", (-1.5, y_pos, 0.7),
               (0.12, 2.5, 1.4), mat_wood_dark)
    # Post
    create_box(f"StallPost_{i}", (-1.5, y_pos, 1.0),
               (0.15, 0.15, 2.0), mat_wood_beam)

# ============================================================
# HAY BALES
# ============================================================

hay_positions = [
    (2.5, -3.5, 0.4),
    (2.5, -2.0, 0.4),
    (3.0, -3.0, 0.4),
    (2.8, -2.5, 1.1),
]

for i, pos in enumerate(hay_positions):
    create_box(f"HayBale_{i}", pos, (1.0, 0.6, 0.7), mat_hay)

# ============================================================
# FEEDING TROUGH
# ============================================================

def create_trough(name, location):
    # Main trough body
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (0.5, 2.0, 0.4)
    bpy.ops.object.transform_apply(scale=True)
    obj.data.materials.append(mat_wood_dark)
    bpy.ops.object.shade_smooth()
    # Legs
    for dy in [-0.7, 0.7]:
        create_box(f"{name}_Leg_{dy}", (location[0], location[1] + dy, location[2] - 0.3),
                   (0.08, 0.08, 0.5), mat_wood_dark)

create_trough("Trough1", (-3.0, 0, 0.6))

# ============================================================
# CHIMNEY (the user's requested addition)
# ============================================================

chimney_x = 2.5
chimney_y = -stable_depth / 2 + 0.5
chimney_base_z = 0
chimney_wall_top = wall_height + roof_peak_height + 1.5

# Chimney base (wider at the bottom, stone hearth)
create_box("ChimneyBase", (chimney_x, chimney_y, 1.0),
           (1.8, 1.6, 2.0), mat_chimney_stone)

# Chimney hearth opening (dark interior)
create_box("ChimneyHearth", (chimney_x, chimney_y + 0.75, 0.6),
           (1.0, 0.3, 1.0), mat_chimney_inside)

# Chimney hearth arch (lintel)
create_box("ChimneyLintel", (chimney_x, chimney_y + 0.7, 1.2),
           (1.2, 0.2, 0.15), mat_wood_beam)

# Chimney stack (goes up through the roof)
chimney_stack_height = chimney_wall_top - wall_height
chimney_stack_center_z = wall_height + chimney_stack_height / 2

create_box("ChimneyStack", (chimney_x, chimney_y, chimney_stack_center_z),
           (1.2, 1.2, chimney_stack_height), mat_chimney_stone)

# Chimney mid-section (through roof area)
create_box("ChimneyMid", (chimney_x, chimney_y, wall_height),
           (1.4, 1.4, 0.3), mat_chimney_stone)

# Chimney top cap (slightly wider crown)
create_box("ChimneyTopCap", (chimney_x, chimney_y, chimney_wall_top + 0.1),
           (1.4, 1.4, 0.2), mat_chimney_stone)

# Chimney pot / flue at top
create_cylinder("ChimneyFlue", (chimney_x, chimney_y, chimney_wall_top + 0.35),
                0.3, 0.4, mat_chimney_stone, vertices=16)

# Chimney cap (rain cover)
create_box("ChimneyRainCap", (chimney_x, chimney_y, chimney_wall_top + 0.65),
           (0.9, 0.9, 0.06), mat_wood_dark)

# Small support posts for rain cap
for dx, dy in [(-0.25, -0.25), (0.25, -0.25), (-0.25, 0.25), (0.25, 0.25)]:
    create_box(f"ChimneyCapPost_{dx}_{dy}",
               (chimney_x + dx, chimney_y + dy, chimney_wall_top + 0.5),
               (0.05, 0.05, 0.25), mat_wood_dark)

# Chimney breast (transition from base to stack, inside the stable)
create_box("ChimneyBreast", (chimney_x, chimney_y, wall_height * 0.75),
           (1.5, 1.3, wall_height * 0.5), mat_chimney_stone)

# Mantel shelf
create_box("ChimneyMantel", (chimney_x, chimney_y + 0.65, 1.35),
           (1.6, 0.25, 0.1), mat_wood_beam)

# ============================================================
# RECALCULATE NORMALS FOR ALL MESH OBJECTS
# ============================================================

for obj in bpy.data.objects:
    if obj.type == 'MESH':
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.normals_make_consistent(inside=False)
        bpy.ops.object.mode_set(mode='OBJECT')
        bpy.ops.object.shade_smooth()
        obj.select_set(False)

# ============================================================
# EXPORT
# ============================================================

output_path = "C:/Users/Utilisateur/Desktop/FabWare/MeshyMyself/meshes/Stable_medieval_1775409093846.glb"
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