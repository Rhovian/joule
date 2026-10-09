import os

import uvicorn

if __name__ == "__main__":
    # One worker is required for the in-process Scan lock (spec §7).
    uvicorn.run(
        "joule.app:app",
        host=os.environ.get("JOULE_HOST", "127.0.0.1"),
        port=8000,
        workers=1,
    )
