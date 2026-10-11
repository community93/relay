"""Capture every palette in an isolated native WebView2 process."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))['version']
QA = ROOT / '.design-qa'
DATA = QA / ('visual-data-' + VERSION)
PORT = int(os.environ.get('RELAY_VISUAL_PORT', '9227'))
EXE = os.environ.get('RELAY_TEST_EXE', str(ROOT / 'src-tauri/target/release/relay.exe'))

def ready():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=1) as response:
            return any(page.get('type') == 'page' for page in json.load(response))
    except Exception:
        return False

def main():
    if ready():
        raise RuntimeError('Visual QA port is already occupied')
    DATA.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, RELAY_DATA=str(DATA), RELAY_VISUAL_DATA=str(DATA),
               RELAY_CDP_URL=f'http://127.0.0.1:{PORT}',
               WEBVIEW2_USER_DATA_FOLDER=str(QA / ('visual-webview-' + VERSION)),
               WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=f'--remote-debugging-port={PORT} --remote-allow-origins=*')
    process = subprocess.Popen([EXE], cwd=Path(EXE).parent, env=env,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.time() + 45
        while not ready():
            if process.poll() is not None or time.time() > deadline:
                raise RuntimeError('Visual QA app did not start')
            time.sleep(.3)
        return subprocess.run(['node', str(ROOT / 'tests/capture_visual_matrix.cjs')],
                              cwd=ROOT, env=env, timeout=300).returncode
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=20)

if __name__ == '__main__':
    sys.exit(main())
