"""Prints a new VAPID key pair for Web Push. Put both lines in the backend's .env.

python -m scripts.generate_vapid_keys
"""

from app.services.push import generate_keys

if __name__ == "__main__":
    private, public = generate_keys()
    print(f"VAPID_PUBLIC_KEY={public}")
    print(f"VAPID_PRIVATE_KEY={private}")
    print("VAPID_SUBJECT=mailto:you@yourdomain.in   # change to your own address")
