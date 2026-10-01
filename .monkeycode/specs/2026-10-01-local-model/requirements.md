# 本地模型能力需求

## Introduction

EasyChat2 SHALL support optional on-device LLM inference while preserving the existing online API path.

## Requirements

### Requirement 1: Model Lifecycle

1. WHEN a user selects a model, the system SHALL show model name, version, size, URL and integrity metadata.
2. WHEN a model download starts, the system SHALL show progress and persist resumable download state.
3. WHEN a model file is incomplete, missing or hash-invalid, the system SHALL mark the model unavailable.
4. WHEN a user deletes a model, the system SHALL remove the model file and clear the active model reference.
5. WHEN model metadata or hash changes, the system SHALL require validation before using the existing file.

### Requirement 2: Provider Switching

1. WHEN local mode is enabled and a validated model exists, the system SHALL route eligible chat requests to the local provider.
2. WHEN local mode is disabled or unavailable, the system SHALL route requests through the existing online API provider.
3. IF local inference fails, the system SHALL preserve the user request and retry through the online API once.
4. WHILE the local model is unavailable, the system SHALL keep the online API path usable.

### Requirement 3: Resource Mutual Exclusion

1. WHEN local inference holds the heavy-resource lock, recording, TTS synthesis and other heavy native work SHALL wait or return a recoverable busy state.
2. WHEN a heavy operation finishes or is cancelled, the system SHALL release its lock.
3. IF lock acquisition fails, the system SHALL preserve the pending user action and show a recoverable state.

### Requirement 4: Native Compatibility

1. The system SHALL keep native local-model integration optional and isolated behind an adapter.
2. The Android build SHALL use Expo CNG/prebuild and the New Architecture configuration already used by the project.
3. The system SHALL pass a local filesystem path to the native model adapter after downloading the model into the app document directory.
