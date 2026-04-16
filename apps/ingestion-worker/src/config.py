import os
from dataclasses import dataclass, field


@dataclass
class Config:
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL", "redis://localhost:6379"))
    database_url: str = field(default_factory=lambda: os.getenv("DATABASE_URL", "postgres://erp:erp@localhost:5432/erp"))
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    s3_endpoint: str = field(default_factory=lambda: os.getenv("S3_ENDPOINT", "http://localhost:9010"))
    s3_access_key: str = field(default_factory=lambda: os.getenv("S3_ACCESS_KEY", "r2local"))
    s3_secret_key: str = field(default_factory=lambda: os.getenv("S3_SECRET_KEY", "r2localpass"))
    s3_bucket: str = field(default_factory=lambda: os.getenv("S3_BUCKET", "erp-documents"))
    milvus_uri: str = field(default_factory=lambda: os.getenv("MILVUS_URI", "http://localhost:19530"))

    # Chunking
    chunk_size: int = field(default_factory=lambda: int(os.getenv("CHUNK_SIZE", "512")))
    chunk_overlap_pct: float = field(default_factory=lambda: float(os.getenv("CHUNK_OVERLAP_PCT", "0.2")))
    # valid values: fixed | semantic | sentence | hierarchical
    # semantic/sentence/hierarchical are stubbed — implement if RAGAS shows they matter
    chunk_strategy: str = field(default_factory=lambda: os.getenv("CHUNK_STRATEGY", "fixed"))

    # Embedding
    embedding_model: str = "text-embedding-3-large"
    embedding_dims: int = 1536
    embed_batch_size: int = 32

    # Reranker
    reranker_enabled: bool = field(default_factory=lambda: os.getenv("RERANKER_ENABLED", "true").lower() == "true")
    reranker_model: str = field(default_factory=lambda: os.getenv("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3"))

    # LLM provider — "openai" or "ollama"
    # Switch by setting LLM_PROVIDER=ollama + LLM_MODEL=llama3.2 in your env file.
    # Everything else (generate / stream interface) stays the same.
    llm_provider: str = field(default_factory=lambda: os.getenv("LLM_PROVIDER", "openai"))
    llm_model: str = field(default_factory=lambda: os.getenv("LLM_MODEL", "gpt-4o"))
    ollama_base_url: str = field(default_factory=lambda: os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"))

    # LLM intent classifier (small/fast model — separate from generation model)
    llm_classifier_model: str = field(default_factory=lambda: os.getenv("LLM_CLASSIFIER_MODEL", "gpt-4o-mini"))

    # MCP tool base URLs — swap to real service URLs in production
    jira_mcp_base_url: str = field(default_factory=lambda: os.getenv("JIRA_MCP_BASE_URL", "http://localhost:3001"))
    confluence_mcp_base_url: str = field(default_factory=lambda: os.getenv("CONFLUENCE_MCP_BASE_URL", "http://localhost:3002"))

    # Governance intercepts
    governance_intercept_enabled: bool = field(default_factory=lambda: os.getenv("GOVERNANCE_INTERCEPT_ENABLED", "true").lower() == "true")
    sensitive_keywords_extra: list = field(default_factory=lambda: [k.strip() for k in os.getenv("SENSITIVE_KEYWORDS_EXTRA", "").split(",") if k.strip()])

    # JSONL audit trail
    audit_jsonl_path: str = field(default_factory=lambda: os.getenv("AUDIT_JSONL_PATH", "/tmp/erp_audit.jsonl"))
    audit_enabled: bool = field(default_factory=lambda: os.getenv("AUDIT_ENABLED", "true").lower() == "true")

    # LLM router thresholds
    llm_router_token_threshold: int = field(default_factory=lambda: int(os.getenv("LLM_ROUTER_TOKEN_THRESHOLD", "4000")))
    llm_router_governance_model: str = field(default_factory=lambda: os.getenv("LLM_ROUTER_GOVERNANCE_MODEL", "gpt-4o"))


config = Config()
