from pathlib import Path
import sys
from flask import Flask, render_template



BASE = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE / "templates"
STATIC_DIR = BASE / "static"

# Ensure directories exist
TEMPLATES_DIR.mkdir(exist_ok=True)
STATIC_DIR.mkdir(exist_ok=True)

# Create a minimal CSS if missing
css_path = STATIC_DIR / "style.css"
if not css_path.exists():
    css_path.write_text(
        """body { font-family: Arial, sans-serif; margin: 2rem; }
h1 { color: #2b6cb0; }
p { color: #333; }"""
    )

# Create the Flask app pointing to the created dirs
app = Flask(__name__, template_folder=str(TEMPLATES_DIR), static_folder=str(STATIC_DIR), static_url_path="/static")


@app.route("/")
def index():
    return render_template("index.html")


if __name__ == "__main__":
    # Development server
    app.run(host="0.0.0.0", port=8000, debug=True)