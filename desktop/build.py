"""Build and exercise the desktop package on a native Windows or macOS host."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.0.0"
ELECTRON = "44.9.3"


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def build(work):
    stage = work / "app"
    stage.mkdir()
    # Select only tracked runtime sources. Never recurse through a user's app/data.
    paths = subprocess.check_output([
        "git", "ls-files", "-z", "--", "app/public", "app/lib", "app/island",
        "app/server.js", "architecture/*.sql", "desk.png", "kitten.png",
    ], cwd=ROOT).decode().split("\0")
    for name in filter(None, paths):
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    shutil.copyfile(ROOT / "desktop/main.mjs", stage / "main.mjs")
    (stage / "package.json").write_text(json.dumps({
        "name": "learning-workbench", "productName": "Learning Workbench",
        "version": VERSION, "type": "module", "main": "main.mjs",
    }))
    windows = sys.platform == "win32"
    arch = "x64" if windows or os.uname().machine == "x86_64" else "arm64"
    platform = "win32" if windows else "darwin"
    cmd = ["electron-packager", str(stage), "Learning Workbench",
           "--electron-version=" + ELECTRON, "--arch=" + arch,
           "--out=" + str(work), "--app-bundle-id=io.github.aiyinsitan520.learningworkbench"]
    if windows:
        cmd.append("--icon=" + str(ROOT / "assets/学习工作台.ico"))
    else:
        icons = work / "Workbench.iconset"
        icons.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                filename = f"icon_{size}x{size}" + ("@2x" if scale == 2 else "") + ".png"
                run("sips", "-z", str(size*scale), str(size*scale),
                    ROOT / "app/public/icon.png", "--out", icons / filename)
        run("iconutil", "-c", "icns", icons)
        cmd.append("--icon=" + str(work / "Workbench.icns"))
    run(shutil.which("npx.cmd" if windows else "npx"), "--yes",
        "--package=@electron/packager@20.3.0", *cmd)
    folder = work / f"Learning Workbench-{platform}-{arch}"
    app = folder / "Learning Workbench.app"
    exe = folder / "Learning Workbench.exe" if windows else app / "Contents/MacOS/Learning Workbench"
    if not windows:
        run("codesign", "--force", "--deep", "--sign", "-", app)
        run("codesign", "--verify", "--deep", "--strict", app)
    run(exe, "--smoke-test", "--user-data-dir=" + str(work / "smoke-profile"), timeout=90)
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    if windows:
        shutil.make_archive(str(output / "Learning-Workbench-Windows-x64"), "zip", folder)
    else:
        volume = work / "disk"
        volume.mkdir()
        shutil.move(app, volume / app.name)
        (volume / "Applications").symlink_to("/Applications")
        run("hdiutil", "create", "-volname", "Learning Workbench", "-srcfolder", volume,
            "-format", "UDZO", output / f"Learning-Workbench-macOS-{arch}.dmg")


if __name__ == "__main__":
    if sys.platform not in ("win32", "darwin"):
        raise SystemExit("Use a Windows or macOS builder")
    with tempfile.TemporaryDirectory() as work:
        build(Path(work))

