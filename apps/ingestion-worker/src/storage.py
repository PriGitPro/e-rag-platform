import logging

import boto3
from botocore.exceptions import ClientError

from config import config

logger = logging.getLogger(__name__)


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=config.s3_endpoint,
        aws_access_key_id=config.s3_access_key,
        aws_secret_access_key=config.s3_secret_key,
    )


def ensure_bucket() -> None:
    s3 = _s3()
    try:
        s3.head_bucket(Bucket=config.s3_bucket)
    except ClientError:
        s3.create_bucket(Bucket=config.s3_bucket)
        logger.info("Created bucket '%s'", config.s3_bucket)


def download_document(storage_key: str) -> bytes:
    s3 = _s3()
    obj = s3.get_object(Bucket=config.s3_bucket, Key=storage_key)
    return obj["Body"].read()
