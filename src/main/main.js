const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, exec, spawn } = require('child_process');

const MESHES_DIR = path.join(__dirname, '..', '..', 'meshes');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const PREVIEWS_DIR = path.join(__dirname, '..', '..', 'previews');
const IMAGES_DIR = path.join(__dirname, '..', '..', 'images');
const HISTORY_DIR = path.join(__dirname, '..', '..', 'history');
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

// Ensure directories exist
[MESHES_DIR, SCRIPTS_DIR, PREVIEWS_DIR, IMAGES_DIR, HISTORY_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Version History ---
// Each project gets a folder in history/ with a versions.json tracking all versions
function getProjectDir(projectName) {
  const dir = path.join(HISTORY_DIR, projectName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadVersions(projectName) {
  const vFile = path.join(getProjectDir(projectName), 'versions.json');
  if (fs.existsSync(vFile)) return JSON.parse(fs.readFileSync(vFile, 'utf-8'));
  return { name: projectName, currentVersion: -1, versions: [] };
}

function saveVersions(projectName, data) {
  const vFile = path.join(getProjectDir(projectName), 'versions.json');
  fs.writeFileSync(vFile, JSON.stringify(data, null, 2));
}

function addVersion(projectName, { prompt, scriptContent, meshPath, meshFilename, format }) {
  const data = loadVersions(projectName);
  const versionNum = data.versions.length;

  // Copy mesh to history
  const histMeshName = `v${versionNum}_${meshFilename}`;
  const histMeshPath = path.join(getProjectDir(projectName), histMeshName);
  fs.copyFileSync(meshPath, histMeshPath);

  // Save script to history
  const histScriptName = `v${versionNum}_script.py`;
  const histScriptPath = path.join(getProjectDir(projectName), histScriptName);
  fs.writeFileSync(histScriptPath, scriptContent, 'utf-8');

  data.versions.push({
    version: versionNum,
    prompt,
    scriptFile: histScriptName,
    meshFile: histMeshName,
    meshPath: histMeshPath,
    format,
    timestamp: Date.now()
  });
  data.currentVersion = versionNum;
  saveVersions(projectName, data);
  return data;
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }
  return { blenderPath: '' };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'FabMesh',
    icon: path.join(__dirname, '..', '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1a1a2e',
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.setMenuBarVisibility(false);

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// Show file in explorer
ipcMain.handle('save-thumbnail', (event, { meshPath, dataUrl }) => {
  const thumbPath = meshPath.replace(/\.[^.]+$/, '_thumb.png');
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(thumbPath, base64, 'base64');
  return thumbPath;
});

ipcMain.handle('get-thumbnail', (event, meshPath) => {
  const thumbPath = meshPath.replace(/\.[^.]+$/, '_thumb.png');
  if (fs.existsSync(thumbPath)) {
    return 'file:///' + thumbPath.replace(/\\/g, '/');
  }
  return null;
});

ipcMain.handle('show-in-explorer', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// Check GPU status
ipcMain.handle('check-gpu', async () => {
  try {
    const result = await new Promise((resolve, reject) => {
      execFile('python', ['-c', `
import torch
total = torch.cuda.get_device_properties(0).total_memory
used = torch.cuda.memory_allocated(0)
reserved = torch.cuda.memory_reserved(0)
print(f"{total},{used},{reserved}")
`], { timeout: 10000 }, (error, stdout) => {
        if (error) { resolve({ available: true, totalGB: 16, usedGB: 0, freeGB: 16 }); return; }
        const [total, used, reserved] = stdout.trim().split(',').map(Number);
        resolve({
          available: true,
          totalGB: +(total / 1024**3).toFixed(1),
          usedGB: +(used / 1024**3).toFixed(1),
          reservedGB: +(reserved / 1024**3).toFixed(1),
          freeGB: +((total - reserved) / 1024**3).toFixed(1)
        });
      });
    });
    return result;
  } catch (e) {
    return { available: false, totalGB: 0, usedGB: 0, freeGB: 0 };
  }
});

// Flash taskbar when generation completes
ipcMain.handle('flash-taskbar', () => {
  if (mainWindow && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
  }
});

// --- Utility: extract Python code from Claude output ---
function extractPythonCode(raw) {
  let code = raw.trim();
  // If there's a ```python block, extract it
  const pyBlockMatch = code.match(/```python\s*\n([\s\S]*?)```/);
  if (pyBlockMatch) return pyBlockMatch[1].trim();
  // If there's a generic ``` block, extract it
  const blockMatch = code.match(/```\s*\n([\s\S]*?)```/);
  if (blockMatch) return blockMatch[1].trim();
  // If it starts with text before "import bpy", strip the text
  const importIdx = code.indexOf('import bpy');
  if (importIdx > 0) return code.slice(importIdx).trim();
  // If starts with ``` on first line
  if (code.startsWith('```python')) code = code.replace(/^```python\n?/, '').replace(/\n?```$/, '');
  else if (code.startsWith('```')) code = code.replace(/^```\n?/, '').replace(/\n?```$/, '');
  return code.trim();
}

// --- Helper: call Claude CLI ---
function callClaude(claudePath, aiModel, prompt) {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.ELECTRON_RUN_AS_NODE;
    let stdout = '', stderr = '';
    const proc = spawn(claudePath, ['--print', '--model', aiModel], {
      env: cleanEnv, shell: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000
    });
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', err => reject(new Error(`Claude CLI: ${err.message}`)));
    proc.on('close', code => {
      if (code !== 0) { reject(new Error(`Claude exited ${code}\n${stderr.slice(0, 300)}`)); return; }
      const result = extractPythonCode(stdout);
      if (!result) { reject(new Error('Claude returned no Python code')); return; }
      resolve(result);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// --- Helper: run Blender script, retry once on error ---
async function runBlenderWithRetry(config, scriptPath, meshPath, scriptContent, claudePath, aiModel) {
  const runBlender = () => new Promise((resolve, reject) => {
    execFile(config.blenderPath, ['--background', '--python', scriptPath], {
      timeout: 120000, maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) { reject({ error: error.message, stdout, stderr }); return; }
      if (!fs.existsSync(meshPath)) { reject({ error: 'Mesh not created', stdout, stderr }); return; }
      const stats = fs.statSync(meshPath);
      resolve({ size: stats.size, stdout, stderr });
    });
  });

  try {
    return await runBlender();
  } catch (blenderErr) {
    // Retry: send error back to Claude to fix
    const errMsg = (blenderErr.stderr || blenderErr.stdout || blenderErr.error || '').slice(0, 500);
    const fixPrompt = `The following Blender Python script has an error. Fix it.

--- SCRIPT WITH ERROR ---
${scriptContent}
--- END SCRIPT ---

--- BLENDER ERROR ---
${errMsg}
--- END ERROR ---

Output ONLY the fixed Python code. No explanations, no markdown.`;

    try {
      const fixedCode = await callClaude(claudePath, 'sonnet', fixPrompt);
      fs.writeFileSync(scriptPath, fixedCode, 'utf-8');
      return await runBlender();
    } catch (retryErr) {
      throw blenderErr; // throw original error if retry also fails
    }
  }
}

// --- AI Generation via Claude CLI ---

ipcMain.handle('generate-from-prompt', async (event, { prompt, outputName, format, model, maxTris }) => {
  try {
    const config = loadConfig();
    if (!config.blenderPath) {
      return { success: false, step: 'ai', error: 'Blender path not configured. Click the gear icon to set it.' };
    }

    const ext = format || 'glb';
    const aiModel = model || 'opus';
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${timestamp}.${ext}`;
    const scriptFilename = `${safeName}_${timestamp}.py`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const scriptPath = path.join(SCRIPTS_DIR, scriptFilename);
    const outputPathEscaped = meshPath.replace(/\\/g, '/');

    // Build the Claude prompt - expert level
    const claudePrompt = `You are an expert Blender 3D artist and Python developer. Generate a production-quality Blender Python script that creates: "${prompt}"

YOU MUST OUTPUT ONLY PYTHON CODE. No explanations, no markdown, no backticks.

TECHNICAL REQUIREMENTS:
1. IMPORTS: import bpy, bmesh, math, from mathutils import Vector, Matrix, Euler
2. SCENE SETUP: Clear all objects, meshes, materials first
3. GEOMETRY - use advanced techniques:
   - Use bmesh for complex shapes (extrude, inset, bevel edges)
   - Combine primitives with boolean modifiers for complex forms
   - Add Subdivision Surface modifier (levels=2, render=3) for smooth organic shapes
   - Add Bevel modifier on hard-surface objects for realistic edges
   - Use proportional editing concepts (scale vertices by distance)
   - Create proper edge loops and topology
4. MATERIALS - create realistic PBR materials:
   - Use Principled BSDF with proper Base Color (NEVER pure black)
   - Set Metallic (0.0 for non-metals, 0.9+ for metals)
   - Set Roughness appropriately (0.1-0.3 polished, 0.5-0.8 rough)
   - Add Bump/Normal nodes with Noise Texture for surface detail
   - Use Color Ramp + Noise Texture for color variation
   - Mix multiple materials on the same object using material slots and face assignment
5. NORMALS: After EVERY mesh edit, recalculate normals:
   bpy.ops.object.editmode_toggle()
   bpy.ops.mesh.select_all(action='SELECT')
   bpy.ops.mesh.normals_make_consistent(inside=False)
   bpy.ops.object.editmode_toggle()
6. SHADING: Apply Shade Smooth + Auto Smooth on all objects
7. DETAILS: Add small details that make the object believable (scratches, wear, beveled edges, slight imperfections)
8. SCALE: Keep objects at realistic scale (1 unit = 1 meter)

EXPORT - use this exact code at the end:
output_path = "${outputPathEscaped}"
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

TRIANGLE BUDGET: ${maxTris > 0 ? `The final mesh MUST stay under ${maxTris.toLocaleString()} triangles total. Use a Decimate modifier (type='COLLAPSE', ratio adjusted) at the end if needed to reduce polycount. Add this check before export:
total_tris = sum(len(obj.data.polygons) for obj in bpy.data.objects if obj.type == 'MESH')
if total_tris > ${maxTris}:
    for obj in bpy.data.objects:
        if obj.type == 'MESH':
            mod = obj.modifiers.new('Decimate', 'DECIMATE')
            mod.ratio = ${maxTris} / max(total_tris, 1)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier='Decimate')
Adapt your geometry complexity to stay within budget. ${maxTris <= 1000 ? 'Use LOW-POLY style: flat shading, minimal vertices, stylized look.' : maxTris <= 5000 ? 'Use MEDIUM detail: good topology, some bevels but keep it efficient.' : 'Use HIGH detail: subdivision, detailed bevels, rich geometry.'}` : 'No triangle limit — use as much detail as needed for quality.'}

Generate detailed geometry that looks like a professional 3D model. Output ONLY Python code.`;

    // Step 1: Call Claude CLI
    const claudePath = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (!fs.existsSync(claudePath)) {
      return { success: false, step: 'ai', error: `Claude CLI not found at: ${claudePath}` };
    }

    let scriptContent;
    try {
      scriptContent = await callClaude(claudePath, aiModel, claudePrompt);
    } catch (err) {
      return { success: false, step: 'ai', error: err.message };
    }

    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

    // Step 2: Run in Blender (with auto-retry on error)
    try {
      const blenderResult = await runBlenderWithRetry(config, scriptPath, meshPath, scriptContent, claudePath, aiModel);
      const result = { meshPath, meshFilename, scriptPath, scriptFilename, format: ext, size: blenderResult.size, scriptContent };
      // Save to version history
      const versionData = addVersion(safeName, {
        prompt,
        scriptContent,
        meshPath: result.meshPath,
        meshFilename: result.meshFilename,
        format: ext
      });

      return { success: true, ...result, versionData };
    } catch (err) {
      return { success: false, step: 'blender', error: err.error || err.message || String(err) };
    }
  } catch (err) {
    return { success: false, step: 'ai', error: `Unexpected error: ${err.message || err}` };
  }
});

// --- Save screenshot from renderer ---
ipcMain.handle('save-screenshot', async (event, { dataUrl, projectName }) => {
  const screenshotPath = path.join(getProjectDir(projectName), `screenshot_${Date.now()}.png`);
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(screenshotPath, base64, 'base64');
  return screenshotPath;
});

// --- Refine existing mesh ---
ipcMain.handle('refine-mesh', async (event, { projectName, modification, format, screenshotPath, model }) => {
  try {
    const config = loadConfig();
    const aiModel = model || 'opus';
    if (!config.blenderPath) {
      return { success: false, step: 'ai', error: 'Blender path not configured.' };
    }

    const data = loadVersions(projectName);
    if (data.versions.length === 0) {
      return { success: false, step: 'ai', error: 'No previous version found to refine.' };
    }

    const currentV = data.versions[data.currentVersion];
    const prevScriptPath = path.join(getProjectDir(projectName), currentV.scriptFile);
    const prevScript = fs.readFileSync(prevScriptPath, 'utf-8');
    const isImported = currentV.imported || prevScript.startsWith('# Imported mesh');

    const ext = format || 'glb';
    const timestamp = Date.now();
    const meshFilename = `${projectName}_${timestamp}.${ext}`;
    const scriptFilename = `${projectName}_${timestamp}.py`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const scriptPath = path.join(SCRIPTS_DIR, scriptFilename);
    const outputPathEscaped = meshPath.replace(/\\/g, '/');

    // Encode screenshot as base64 to embed in prompt if available
    let screenshotB64 = '';
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const imgBuf = fs.readFileSync(screenshotPath);
      screenshotB64 = imgBuf.toString('base64');
    }

    let claudePrompt;

    if (isImported) {
      // Imported mesh — import the original file in Blender and modify it
      const originalMeshPath = currentV.meshPath.replace(/\\/g, '/');
      const originalExt = path.extname(currentV.meshPath).slice(1).toLowerCase();

      // Determine import command based on format
      let importCmd = '';
      if (originalExt === 'fbx') importCmd = `bpy.ops.import_scene.fbx(filepath="${originalMeshPath}")`;
      else if (originalExt === 'obj') importCmd = `bpy.ops.wm.obj_import(filepath="${originalMeshPath}")`;
      else if (originalExt === 'glb' || originalExt === 'gltf') importCmd = `bpy.ops.import_scene.gltf(filepath="${originalMeshPath}")`;
      else if (originalExt === 'stl') importCmd = `bpy.ops.import_mesh.stl(filepath="${originalMeshPath}")`;

      claudePrompt = `You are an expert Blender 3D artist. The user has an imported 3D mesh and wants to modify it IN PLACE.

Generate a Blender Python script that:
1. Clears the default scene
2. Imports the original mesh with: ${importCmd}
3. Applies the user's modification: "${modification}"
4. Exports the result

IMPORTANT: You are MODIFYING the imported mesh, NOT recreating it from scratch. The original geometry and materials must be preserved. Only add/change what the user asks for.

Techniques you can use to modify the imported mesh:
- Add new objects (primitives, meshes) alongside the imported ones
- Select imported objects by name and modify them (scale, move, add modifiers)
- Use bmesh to edit geometry of selected objects
- Add/modify materials on existing objects
- Duplicate parts of the mesh and transform them
- Use boolean modifiers to cut or add geometry

CRITICAL RULES:
- Output ONLY Python code, no markdown, no backticks, no explanations
- Start by clearing default objects, then import the original mesh
- Preserve the original mesh and its materials/textures as much as possible
- Any NEW objects you add MUST have realistic PBR materials that MATCH the style of the existing mesh
- IMPORTANT: After importing, inspect existing materials to understand the visual style. Copy or reuse existing materials where possible:
  for mat in bpy.data.materials:
      if mat.use_nodes:
          # reuse this material on new objects if appropriate
- For NEW objects: REUSE the existing materials from the imported mesh. After import, get the main material and assign it to new objects:
  main_mat = None
  for mat in bpy.data.materials:
      if mat.use_nodes:
          for node in mat.node_tree.nodes:
              if node.type == 'TEX_IMAGE' and node.image:
                  main_mat = mat
                  break
  # Then for each new object: new_obj.data.materials.append(main_mat)
- This ensures new objects share the same texture as the imported mesh
- If you need a different look (e.g. metal cap), create a simple material with Base Color set directly (no Noise/ColorRamp nodes - those don't export to GLTF)
- Make new geometry detailed: use bevels, loop cuts, and subdivision for realistic shapes - NOT just plain cubes/cylinders
- NEVER leave any object with the default white material
- Recalculate normals after any mesh modifications
- Use Shade Smooth where appropriate
- IMPORTANT: Before export, you MUST ensure textures are preserved. Add this code block BEFORE the export:

# Fix materials for GLTF export - ensure all use Principled BSDF
for mat in bpy.data.materials:
    if mat.use_nodes:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_DIFFUSE' or node.type == 'BSDF_GLOSSY':
                # Already has Principled? Skip
                pass
bpy.ops.file.pack_all()

The export code at the end MUST be exactly:

bpy.ops.file.pack_all()
output_path = "${outputPathEscaped}"
if output_path.endswith('.glb') or output_path.endswith('.gltf'):
    fmt = 'GLB' if output_path.endswith('.glb') else 'GLTF_SEPARATE'
    bpy.ops.export_scene.gltf(filepath=output_path, export_format=fmt, export_image_format='AUTO', export_materials='EXPORT')
elif output_path.endswith('.obj'):
    bpy.ops.wm.obj_export(filepath=output_path)
elif output_path.endswith('.fbx'):
    bpy.ops.export_scene.fbx(filepath=output_path)
elif output_path.endswith('.stl'):
    bpy.ops.export_mesh.stl(filepath=output_path)
print("FABMESH_SUCCESS")

Output ONLY valid Python code.`;
    } else {
      // Normal refine — has previous script
      claudePrompt = `Here is an existing Blender Python script that creates a 3D object:

--- EXISTING SCRIPT ---
${prevScript}
--- END SCRIPT ---

The user wants to MODIFY this object with the following request: "${modification}"

Generate a NEW complete Blender Python script that includes the modification. Keep everything that was good in the original script, and apply the requested changes.

CRITICAL RULES:
- Output ONLY the Python code, no markdown, no backticks, no explanations
- Keep the same overall structure but apply the modifications
- Recalculate normals outward after mesh edits
- Use Shade Smooth on objects
- Apply realistic PBR materials with visible colors (never pure black)
- Ensure all faces have correct normals so nothing appears dark/invisible

The export code at the end MUST be exactly:

output_path = "${outputPathEscaped}"
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

Output ONLY valid Python code.`;
    }

    const claudePath = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
    if (!fs.existsSync(claudePath)) {
      return { success: false, step: 'ai', error: 'Claude CLI not found.' };
    }

    let scriptContent;
    try {
      scriptContent = await callClaude(claudePath, aiModel, claudePrompt);
    } catch (err) {
      return { success: false, step: 'ai', error: err.message };
    }

    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

    try {
      const blenderResult = await runBlenderWithRetry(config, scriptPath, meshPath, scriptContent, claudePath, aiModel);
      const result = { meshPath, meshFilename, scriptPath, scriptFilename, format: ext, size: blenderResult.size, scriptContent };

      const versionData = addVersion(projectName, {
        prompt: `[Refine] ${modification}`,
        scriptContent,
        meshPath: result.meshPath,
        meshFilename: result.meshFilename,
        format: ext
      });

      return { success: true, ...result, versionData };
    } catch (err) {
      return { success: false, step: 'blender', error: err.error || err.message || String(err) };
    }
  } catch (err) {
    return { success: false, step: 'ai', error: `Unexpected: ${err.message}` };
  }
});

// --- Version history handlers ---
ipcMain.handle('get-versions', (event, projectName) => {
  return loadVersions(projectName);
});

ipcMain.handle('revert-to-version', async (event, { projectName, versionNum }) => {
  const data = loadVersions(projectName);
  if (versionNum < 0 || versionNum >= data.versions.length) {
    return { success: false, error: 'Invalid version number' };
  }
  data.currentVersion = versionNum;
  saveVersions(projectName, data);
  const v = data.versions[versionNum];
  return { success: true, meshPath: v.meshPath, meshFile: v.meshFile, format: v.format, versionData: data };
});

ipcMain.handle('list-projects', () => {
  if (!fs.existsSync(HISTORY_DIR)) return [];
  return fs.readdirSync(HISTORY_DIR)
    .filter(d => fs.existsSync(path.join(HISTORY_DIR, d, 'versions.json')))
    .map(d => {
      const data = loadVersions(d);
      return { name: d, versionCount: data.versions.length, currentVersion: data.currentVersion };
    });
});

// --- Construction Mode: 3 build stages ---
ipcMain.handle('generate-build-stages', async (event, { prompt, outputName, engine }) => {
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const results = [];

    const stagePrompts = [
      { name: 'stage1', label: 'Stage 1: Construction Site', imgPrompt: `construction site foundation of ${prompt}, building materials piles, scaffolding, cleared ground, early construction phase, no building yet, isometric view, white background, 3D render` },
      { name: 'stage2', label: 'Stage 2: Under Construction', imgPrompt: `half-built ${prompt}, walls partially built, wooden frame visible, scaffolding, roof beams without tiles, unfinished building, isometric view, white background, 3D render` },
      { name: 'stage3', label: 'Stage 3: Complete', imgPrompt: `completed finished ${prompt}, full detail, roof tiles, windows doors installed, decorative details, polished building, isometric view, white background, 3D render` }
    ];

    for (let i = 0; i < stagePrompts.length; i++) {
      const stage = stagePrompts[i];
      if (mainWindow) mainWindow.webContents.send('build-stage-progress', { stage: i, total: 3, label: stage.label });

      const timestamp = Date.now();
      const imgDir = path.join(IMAGES_DIR, `${safeName}_${stage.name}_${timestamp}`);
      fs.mkdirSync(imgDir, { recursive: true });

      // Step 1: Generate image via Pollinations
      const imgPath = path.join(imgDir, 'ref_0.png');
      try {
        const https = require('https');
        const encoded = encodeURIComponent(stage.imgPrompt);
        const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${timestamp}`;
        await new Promise((resolve, reject) => {
          const req = https.get(url, { headers: { 'User-Agent': 'FabMesh/1.0' }, timeout: 120000 }, (resp) => {
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
              https.get(resp.headers.location, { headers: { 'User-Agent': 'FabMesh/1.0' } }, (r2) => {
                const chunks = []; r2.on('data', c => chunks.push(c)); r2.on('end', () => { fs.writeFileSync(imgPath, Buffer.concat(chunks)); resolve(); }); r2.on('error', reject);
              });
              return;
            }
            const chunks = []; resp.on('data', c => chunks.push(c)); resp.on('end', () => { fs.writeFileSync(imgPath, Buffer.concat(chunks)); resolve(); }); resp.on('error', reject);
          });
          req.on('error', reject);
        });
      } catch (e) {
        results.push({ stage: i, success: false, label: stage.label, error: `Image failed: ${e.message}` });
        continue;
      }

      // Step 2: Convert image to 3D
      const meshFilename = `${safeName}_${stage.name}_${timestamp}.glb`;
      const meshPath = path.join(MESHES_DIR, meshFilename);
      const selectedEngine = engine || 'local';
      const bridgeScripts = {
        'trellis2': path.join(__dirname, '..', '..', 'scripts', 'local_trellis2_bridge.py'),
        'local': path.join(__dirname, '..', '..', 'scripts', 'local_triposr_bridge.py'),
        'triposg': path.join(__dirname, '..', '..', 'scripts', 'triposg_bridge.py'),
        'trellis': path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py')
      };
      const bridgeScript = bridgeScripts[selectedEngine] || bridgeScripts['trellis2'];
      const argsMap = {
        'trellis2': [bridgeScript, imgPath, meshPath],
        'local': [bridgeScript, imgPath, meshPath, '512'],
        'triposg': [bridgeScript, imgPath, meshPath, '50000'],
        'trellis': [bridgeScript, imgPath, meshPath, '0.95', '1024']
      };
      const args = argsMap[selectedEngine] || argsMap['trellis2'];

      try {
        await new Promise((resolve, reject) => {
          execFile('python', args, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) { reject({ error: error.message, stdout, stderr }); return; }
            if (!fs.existsSync(meshPath)) { reject({ error: 'Mesh not created' }); return; }
            resolve();
          });
        });
        const stats = fs.statSync(meshPath);
        results.push({ stage: i, success: true, label: stage.label, meshPath, meshFilename, format: 'glb', size: stats.size, imagePath: imgPath });
      } catch (err) {
        results.push({ stage: i, success: false, label: stage.label, error: `3D conversion failed: ${err.error || err.message}` });
      }
    }

    return { success: true, stages: results };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// --- Text-to-3D: Step 1 - Generate images via Pollinations ---
ipcMain.handle('generate-images', async (event, { prompt, numImages, projectName, engine }) => {
  try {
    const timestamp = Date.now();
    const safeName = (projectName || 'gen').replace(/[^a-zA-Z0-9_-]/g, '_');
    const imagesDir = path.join(IMAGES_DIR, `${safeName}_${timestamp}`);
    fs.mkdirSync(imagesDir, { recursive: true });

    // Save prompt to file for later retrieval
    fs.writeFileSync(path.join(imagesDir, 'prompt.txt'), prompt, 'utf-8');

    // LOCAL GPU: Stable Diffusion
    if (engine === 'local-sd') {
      const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'local_image_bridge.py');
      const result = await new Promise((resolve, reject) => {
        const proc = execFile('python', [bridgeScript, prompt, imagesDir, String(numImages || 4)], {
          timeout: 600000, maxBuffer: 10 * 1024 * 1024
        }, (error, stdout, stderr) => {
          if (error) { reject({ error: error.message, stdout, stderr }); return; }
          // Collect generated images
          const imgs = fs.readdirSync(imagesDir).filter(f => /\.png$/i.test(f)).map(f => path.join(imagesDir, f));
          resolve({ images: imgs, stdout });
        });
        proc.stdout.on('data', d => { if (mainWindow) mainWindow.webContents.send('ai3d-progress', d.toString()); });
      });
      return { success: true, images: result.images };
    }

    // CLOUD: Pollinations
    const images = [];
    const optimizedPrompt = `3D render of ${prompt}, single object centered on plain white background, studio lighting, high detail, no text, isometric view, product photography`;

    for (let i = 0; i < (numImages || 4); i++) {
      const seed = timestamp + i;
      const encoded = encodeURIComponent(optimizedPrompt);
      const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&seed=${seed}`;
      const imgPath = path.join(imagesDir, `ref_${i}.png`);

      try {
        const https = require('https');
        await new Promise((resolve, reject) => {
          const req = https.get(url, { headers: { 'User-Agent': 'FabMesh/1.0' }, timeout: 120000 }, (resp) => {
            if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
              https.get(resp.headers.location, { headers: { 'User-Agent': 'FabMesh/1.0' } }, (resp2) => {
                const chunks = [];
                resp2.on('data', c => chunks.push(c));
                resp2.on('end', () => { fs.writeFileSync(imgPath, Buffer.concat(chunks)); resolve(); });
                resp2.on('error', reject);
              });
              return;
            }
            const chunks = [];
            resp.on('data', c => chunks.push(c));
            resp.on('end', () => { fs.writeFileSync(imgPath, Buffer.concat(chunks)); resolve(); });
            resp.on('error', reject);
          });
          req.on('error', reject);
        });
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).size > 1000) {
          images.push(imgPath);
          if (mainWindow) mainWindow.webContents.send('ai3d-progress', `IMAGE_GENERATED:${i}:${imgPath}`);
        }
      } catch (e) {
        console.error(`Image ${i} failed:`, e.message);
      }
    }

    return { success: true, images };
  } catch (err) {
    return { success: false, error: err.error || err.message };
  }
});

// --- Image-to-3D: supports TRELLIS and TripoSG ---
ipcMain.handle('image-to-3d', async (event, { imagePath: _imagePath, outputName, textureSize, engine, targetFaces }) => {
  let imagePath = _imagePath;
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${engine || 'ai'}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScripts = {
      'hunyuan': path.join(__dirname, '..', '..', 'scripts', 'local_hunyuan3d_bridge.py'),
      'local': path.join(__dirname, '..', '..', 'scripts', 'local_triposr_bridge.py'),
      'trellis': path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py')
    };
    const bridgeScript = bridgeScripts[engine] || bridgeScripts['local'];

    const argsMap = {
      'hunyuan': [bridgeScript, imagePath, meshPath, String(targetFaces || 0)],
      'local': [bridgeScript, imagePath, meshPath, '512'],
      'trellis': [bridgeScript, imagePath, meshPath, '0.95', String(textureSize || 1024)]
    };
    const args = argsMap[engine] || argsMap['local'];

    // Fix truncated image path (known bug: last char gets cut)
    if (!fs.existsSync(imagePath)) {
      const fixes = ['g', 'ng', 'png', 'pg', 'jpg', 'peg'];
      for (const fix of fixes) {
        if (fs.existsSync(imagePath + fix)) {
          imagePath = imagePath + fix;
          break;
        }
      }
      if (!fs.existsSync(imagePath)) {
        return { success: false, error: `Image not found: ${imagePath}` };
      }
    }
    // Rebuild args with fixed path
    const fixedArgsMap = {
      'hunyuan': [bridgeScript, imagePath, meshPath, String(targetFaces || 0)],
      'local': [bridgeScript, imagePath, meshPath, '512'],
      'trellis': [bridgeScript, imagePath, meshPath, '0.95', String(textureSize || 1024)]
    };
    const fixedArgs = fixedArgsMap[engine] || fixedArgsMap['local'];

    console.log('IMAGE-TO-3D fixedArgs:', JSON.stringify(fixedArgs));
    fs.writeFileSync(path.join(__dirname, '..', '..', 'last_error.log'), `imagePath: ${imagePath}\nfixedArgs: ${JSON.stringify(fixedArgs)}\n`);
    const result = await new Promise((resolve, reject) => {
      const proc = execFile('python', fixedArgs, {
        timeout: 600000,
        maxBuffer: 10 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) { reject({ error: error.message, stdout, stderr }); return; }
        if (!fs.existsSync(meshPath)) { reject({ error: 'GLB not created', stdout, stderr }); return; }
        const stats = fs.statSync(meshPath);
        resolve({ meshPath, meshFilename, format: 'glb', size: stats.size, stdout });
      });
      proc.stdout.on('data', d => { if (mainWindow) mainWindow.webContents.send('ai3d-progress', d.toString()); });
    });

    return { success: true, ...result };
  } catch (err) {
    const errMsg = err.error || err.message || String(err);
    fs.appendFileSync(path.join(__dirname, '..', '..', 'last_error.log'), `\nERROR: ${errMsg}\nstdout: ${err.stdout || ''}\nstderr: ${err.stderr || ''}\n`);
    return { success: false, error: errMsg, stdout: err.stdout, stderr: err.stderr };
  }
});

// --- Legacy: TRELLIS only (kept for compatibility) ---
ipcMain.handle('image-to-3d-trellis', async (event, { imagePath, outputName, textureSize }) => {
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py');

    const result = await new Promise((resolve, reject) => {
      const proc = execFile('python', [bridgeScript, imagePath, meshPath, String(textureSize || 1024)], {
        timeout: 600000,
        maxBuffer: 10 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) { reject({ error: error.message, stdout, stderr }); return; }
        if (!fs.existsSync(meshPath)) { reject({ error: 'GLB not created', stdout, stderr }); return; }
        const stats = fs.statSync(meshPath);
        resolve({ meshPath, meshFilename, format: 'glb', size: stats.size, stdout });
      });
      proc.stdout.on('data', d => { if (mainWindow) mainWindow.webContents.send('ai3d-progress', d.toString()); });
    });

    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.error || err.message, stdout: err.stdout, stderr: err.stderr };
  }
});

// --- TRELLIS Image-to-3D via Hugging Face ---
ipcMain.handle('generate-from-image', async (event, { imagePath, outputName }) => {
  try {
    const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = Date.now();
    const meshFilename = `${safeName}_${timestamp}.glb`;
    const meshPath = path.join(MESHES_DIR, meshFilename);
    const bridgeScript = path.join(__dirname, '..', '..', 'scripts', 'trellis_bridge.py');

    const result = await new Promise((resolve, reject) => {
      execFile('python', [bridgeScript, imagePath, meshPath], {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error) {
          reject({ error: error.message, stdout, stderr });
          return;
        }
        if (!fs.existsSync(meshPath)) {
          reject({ error: 'GLB file was not created', stdout, stderr });
          return;
        }
        const stats = fs.statSync(meshPath);
        resolve({
          meshPath,
          meshFilename,
          format: 'glb',
          size: stats.size,
          stdout
        });
      });
    });

    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.error || err.message || String(err), stdout: err.stdout, stderr: err.stderr };
  }
});

// --- IPC Handlers ---

ipcMain.handle('import-mesh', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import 3D Mesh',
    filters: [
      { name: '3D Meshes', extensions: ['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const srcPath = result.filePaths[0];
  return copyMeshToMeshes(srcPath);
});

ipcMain.handle('copy-mesh-to-project', (event, srcPath) => {
  return copyMeshToMeshes(srcPath);
});

function copyMeshToMeshes(srcPath) {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  const baseName = path.basename(srcPath, path.extname(srcPath)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = Date.now();
  const filename = `${baseName}_${timestamp}.${ext}`;
  const destPath = path.join(MESHES_DIR, filename);
  fs.copyFileSync(srcPath, destPath);
  const stats = fs.statSync(destPath);
  return {
    meshPath: destPath,
    meshFilename: filename,
    format: ext,
    size: stats.size
  };
}

ipcMain.handle('create-project-from-mesh', (event, { projectName, meshPath, meshFilename, format }) => {
  const data = loadVersions(projectName);
  if (data.versions.length > 0) return data; // already exists

  // Copy mesh to history
  const histMeshName = `v0_${meshFilename}`;
  const histMeshPath = path.join(getProjectDir(projectName), histMeshName);
  fs.copyFileSync(meshPath, histMeshPath);

  // Create a placeholder script that just describes the import
  const histScriptName = `v0_script.py`;
  const histScriptPath = path.join(getProjectDir(projectName), histScriptName);
  fs.writeFileSync(histScriptPath, `# Imported mesh: ${meshFilename}\n# No generation script available - this was imported from an external file.\n`, 'utf-8');

  data.versions.push({
    version: 0,
    prompt: `[Imported] ${meshFilename}`,
    scriptFile: histScriptName,
    meshFile: histMeshName,
    meshPath: histMeshPath,
    format: format || 'glb',
    imported: true,
    timestamp: Date.now()
  });
  data.currentVersion = 0;
  saveVersions(projectName, data);
  return data;
});

ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('set-blender-path', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Blender executable',
    filters: [{ name: 'Blender', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const config = loadConfig();
    config.blenderPath = result.filePaths[0];
    saveConfig(config);
    return config.blenderPath;
  }
  return null;
});

ipcMain.handle('run-blender-script', async (event, { scriptContent, outputName, format }) => {
  const config = loadConfig();
  if (!config.blenderPath) {
    throw new Error('Blender path not configured. Please set it in settings.');
  }

  const ext = format || 'glb';
  const safeName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestamp = Date.now();
  const meshFilename = `${safeName}_${timestamp}.${ext}`;
  const scriptFilename = `${safeName}_${timestamp}.py`;
  const meshPath = path.join(MESHES_DIR, meshFilename);
  const scriptPath = path.join(SCRIPTS_DIR, scriptFilename);

  // Inject the output path into the script
  const fullScript = scriptContent.replace(/__OUTPUT_PATH__/g, meshPath.replace(/\\/g, '/'));
  fs.writeFileSync(scriptPath, fullScript, 'utf-8');

  return new Promise((resolve, reject) => {
    const args = ['--background', '--python', scriptPath];
    const proc = execFile(config.blenderPath, args, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stdout, stderr });
        return;
      }
      if (!fs.existsSync(meshPath)) {
        reject({ error: 'Mesh file was not created', stdout, stderr });
        return;
      }
      const stats = fs.statSync(meshPath);
      resolve({
        meshPath: meshPath,
        meshFilename,
        scriptPath,
        scriptFilename,
        format: ext,
        size: stats.size,
        stdout,
        stderr
      });
    });
  });
});

ipcMain.handle('list-meshes', () => {
  if (!fs.existsSync(MESHES_DIR)) return [];
  const files = fs.readdirSync(MESHES_DIR);
  return files
    .filter(f => /\.(glb|gltf|obj|fbx|stl|ply)$/i.test(f))
    .map(f => {
      const stats = fs.statSync(path.join(MESHES_DIR, f));
      return {
        filename: f,
        path: path.join(MESHES_DIR, f),
        size: stats.size,
        created: stats.birthtime,
        format: path.extname(f).slice(1).toUpperCase()
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
});

ipcMain.handle('get-mesh-path', (event, filename) => {
  return path.join(MESHES_DIR, filename);
});

ipcMain.handle('delete-mesh', (event, filename) => {
  // Delete from meshes/
  const meshPath = path.join(MESHES_DIR, filename);
  if (fs.existsSync(meshPath)) {
    fs.unlinkSync(meshPath);
  }

  // Also delete from version history if it exists
  const projName = filename.replace(/\.[^.]+$/, '').replace(/_\d+$/, '');
  const projDir = path.join(HISTORY_DIR, projName);
  if (fs.existsSync(path.join(projDir, 'versions.json'))) {
    const data = loadVersions(projName);
    // Find matching version by mesh filename
    const vIdx = data.versions.findIndex(v => {
      const vMeshBase = v.meshFile.replace(/^v\d+_/, '');
      return filename === vMeshBase || filename.endsWith(vMeshBase);
    });
    if (vIdx >= 0) {
      const v = data.versions[vIdx];
      // Delete history mesh file
      const histMesh = path.join(projDir, v.meshFile);
      if (fs.existsSync(histMesh)) fs.unlinkSync(histMesh);
      // Delete history script file
      const histScript = path.join(projDir, v.scriptFile);
      if (fs.existsSync(histScript)) fs.unlinkSync(histScript);
      // Remove from versions array
      data.versions.splice(vIdx, 1);
      // Renumber remaining versions
      data.versions.forEach((ver, i) => ver.version = i);
      // Adjust currentVersion
      if (data.versions.length === 0) {
        data.currentVersion = -1;
        // Remove the whole project dir if empty
        try { fs.unlinkSync(path.join(projDir, 'versions.json')); fs.rmdirSync(projDir); } catch(e) {}
      } else {
        if (data.currentVersion >= data.versions.length) data.currentVersion = data.versions.length - 1;
        else if (data.currentVersion > vIdx) data.currentVersion--;
        saveVersions(projName, data);
      }
    }
  }

  return true;
});

ipcMain.handle('import-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('delete-file', (event, filePath) => {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
});

ipcMain.handle('delete-image-folder', (event, folderPath) => {
  if (fs.existsSync(folderPath)) {
    fs.rmSync(folderPath, { recursive: true, force: true });
    return true;
  }
  return false;
});

ipcMain.handle('open-meshes-folder', () => {
  shell.openPath(MESHES_DIR);
});

ipcMain.handle('open-images-folder', () => {
  shell.openPath(IMAGES_DIR);
});

ipcMain.handle('list-image-folders', () => {
  if (!fs.existsSync(IMAGES_DIR)) return [];
  return fs.readdirSync(IMAGES_DIR)
    .filter(d => fs.statSync(path.join(IMAGES_DIR, d)).isDirectory())
    .map(d => {
      const dir = path.join(IMAGES_DIR, d);
      const imgs = fs.readdirSync(dir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
      const promptFile = path.join(dir, 'prompt.txt');
      const prompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf-8').trim() : '';
      return {
        name: d,
        path: dir,
        images: imgs.map(f => path.join(dir, f)),
        count: imgs.length,
        created: fs.statSync(dir).birthtime,
        prompt
      };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
});

ipcMain.handle('get-mesh-local-url', (event, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  // Return file:// URL for direct loading by Three.js loaders
  return 'file:///' + filePath.replace(/\\/g, '/');
});

ipcMain.handle('read-mesh-file', (event, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

ipcMain.handle('export-mesh', async (event, { sourcePath, targetFormat }) => {
  const config = loadConfig();
  if (!config.blenderPath) throw new Error('Blender path not configured');

  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  const outputPath = path.join(MESHES_DIR, `${baseName}.${targetFormat}`);

  const exportScript = `
import bpy
import sys

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# Import
src = "${sourcePath.replace(/\\/g, '/')}"
ext = src.rsplit('.', 1)[-1].lower()
if ext in ('glb', 'gltf'):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == 'obj':
    bpy.ops.wm.obj_import(filepath=src)
elif ext == 'fbx':
    bpy.ops.import_scene.fbx(filepath=src)
elif ext == 'stl':
    bpy.ops.import_mesh.stl(filepath=src)

# Export
out = "${outputPath.replace(/\\/g, '/')}"
fmt = "${targetFormat}"
if fmt in ('glb', 'gltf'):
    bpy.ops.export_scene.gltf(filepath=out, export_format='${ targetFormat === 'glb' ? 'GLB' : 'GLTF_SEPARATE'}')
elif fmt == 'obj':
    bpy.ops.wm.obj_export(filepath=out)
elif fmt == 'fbx':
    bpy.ops.export_scene.fbx(filepath=out)
elif fmt == 'stl':
    bpy.ops.export_mesh.stl(filepath=out)
`;

  const tmpScript = path.join(SCRIPTS_DIR, `export_${Date.now()}.py`);
  fs.writeFileSync(tmpScript, exportScript);

  return new Promise((resolve, reject) => {
    execFile(config.blenderPath, ['--background', '--python', tmpScript], {
      timeout: 60000
    }, (error, stdout, stderr) => {
      fs.unlinkSync(tmpScript);
      if (error) reject({ error: error.message, stderr });
      else if (!fs.existsSync(outputPath)) reject({ error: 'Export failed' });
      else resolve({ path: outputPath, filename: path.basename(outputPath) });
    });
  });
});
