from .base import BaseLLM

_instance: BaseLLM | None = None


def get_llm() -> BaseLLM:
    """Return a cached LLM instance for the configured provider."""
    global _instance
    if _instance is None:
        _instance = _build()
    return _instance


def _build() -> BaseLLM:
    from config import config  # local import avoids circular deps at module level

    if config.llm_provider == "ollama":
        from .ollama_provider import OllamaProvider
        return OllamaProvider(model=config.llm_model, base_url=config.ollama_base_url)

    if config.llm_provider == "openai":
        from .openai_provider import OpenAIProvider
        return OpenAIProvider(model=config.llm_model, api_key=config.openai_api_key)

    raise ValueError(
        f"Unknown LLM_PROVIDER={config.llm_provider!r}. Valid values: openai, ollama"
    )
