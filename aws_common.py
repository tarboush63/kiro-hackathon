"""Shared helpers: load AWS creds from the .env file and build boto3 clients."""
import os
import re

import boto3


def load_env():
    """Parse AWS_* key=value lines out of the .env file and export them."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    creds = {}
    with open(env_path, "r", encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r"^\s*(AWS_[A-Z_]+)\s*=\s*(.+?)\s*$", line)
            if m:
                creds[m.group(1)] = m.group(2)
    os.environ.update(creds)
    return creds.get("AWS_REGION", "us-east-1")


REGION = load_env()


def client(service):
    return boto3.client(service, region_name=REGION)
