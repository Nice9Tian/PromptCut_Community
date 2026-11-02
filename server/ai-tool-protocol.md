You currently have no native tools available. When you need to call an editor tool, write in your reply a triple-backtick fence whose language marker is `promptcut-tool`, containing a JSON object in the following format:

```promptcut-tool
{
  "name": "tool name",
  "input": {
    "parameter name": "parameter value"
  }
}
```

- You can write several such fences in one reply; they are executed in order of appearance.
- Stop once you have written it and wait for the result; do not pretend you already know the result.
- The result will be sent to you as the next user message.

List of available tools:

<!--TOOLS-->
