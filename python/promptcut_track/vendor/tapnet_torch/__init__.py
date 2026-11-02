"""PyTorch inference code of google-deepmind/tapnet (carried over as is, with only the in-package import paths changed).

Source: https://github.com/google-deepmind/tapnet  (tapnet/torch/)
License: Apache License 2.0, see LICENSE in the same directory. The official statement is explicit that the pretrained weights are also Apache 2.0.

Copied in rather than installed with pip at runtime: tapnet is not a release package that targets PyTorch
inference, and installing it would drag in the training-side JAX dependencies as well. Only three files are needed here.

**Changes are limited to**: rewriting `from tapnet.torch import X` as `from . import X`,
so that it works as a submodule of this package. Not a single line of the model structure or numerics was touched.
"""
