"""Silent launcher for ThickEarth: no console window, one double-click.

Starts the local server from the desktop source tree and opens the browser.
DB_PATH deliberately points at the installed app's database so the existing
AI provider settings (and the secret file that decrypts its API key) carry
over instead of showing up as "not configured" again.
"""

import os
import subprocess
import time
import urllib.request
import webbrowser

APP = r"C:\Users\Aiden\OneDrive\Desktop\ThickEarth-Connect6"
PORT = 8787
URL = "http://127.0.0.1:%d/" % PORT
DB = os.path.join(os.environ.get("LOCALAPPDATA", ""), "ThickEarth", "data", "thick-earth.db")


def alive():
    try:
        with urllib.request.urlopen(URL + "api/config", timeout=1) as response:
            response.read()
        return True
    except Exception:
        return False


def alert(text):
    import ctypes
    ctypes.windll.user32.MessageBoxW(0, text, "ThickEarth", 0x10)


def main():
    env = dict(os.environ)
    env.update({
        "APP_MODE": "desktop",
        "HOST": "127.0.0.1",
        "PORT": str(PORT),
    })
    if os.path.isfile(DB):
        env["DB_PATH"] = DB

    if not alive():
        try:
            subprocess.Popen(
                ["node", os.path.join(APP, "server", "index.js")],
                cwd=APP,
                env=env,
                creationflags=0x08000000 | 0x00000008,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as error:
            alert("Cannot start Node.js. Install Node 22.5 or newer.\n\n" + str(error))
            return
        for _ in range(40):
            if alive():
                break
            time.sleep(0.2)
        else:
            alert("The server did not become ready on " + URL)
            return
    webbrowser.open(URL)


main()
