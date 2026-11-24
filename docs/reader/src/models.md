# Choose and connect models

Use **Quick compare** when you are still shaping the task. Use **Dataset run** when you have cases to repeat across candidate models or versions. The two workflows share the **Model roster** and **Starting line**.

## Connect a candidate

| Where inference runs | How to connect it |
| --- | --- |
| On this device | Start the LM Studio server on port `1234` or Ollama on `11434`. Load a chat model and choose **Refresh** in the roster. In **Developer**, check the LM Studio instance and active context when reported. A downloaded model can appear before it is loaded. |
| At a frontier provider or private on-premises host | Open **Connect a model endpoint** below the roster in **Dataset run** or after prompt approval in **Quick compare**. Enter the OpenAI-compatible API base, exact model identifier and any required credential. Assign **Frontier Labs**, **Fine-tuned** or **Hosted** and select **Save endpoint**. Confirm the destination shown on the starting line before sending case inputs. |

A model’s roster section helps you find it. The endpoint determines where the prompt goes. The **candidate** generates an answer. A **judge** evaluates that answer against the selected metric. Choose the judge separately in the grader configuration.

## Try one objective in Quick compare

1. Open **Quick compare** and enter an objective such as “Flag any incoming bearing that exceeds the drawing’s upper limit.”
2. Choose **Suggest Metrics**. For the bearing task, review two measures: the share of defective parts caught and the share of good parts incorrectly flagged. Edit what counts as success. Draft and approve the prompt. Local planning uses a loaded LFM3. An optional OpenAI planning fallback can be configured in **Domain agents**.
3. Search the roster and click two different models onto the starting line. Check the destination and token allocation for each. Review any attached grader and choose **GO**.
4. In the result, compare both responses to the same approved objective. Use [a dataset](dataset-runs.md) to see whether the behavior repeats across cases.

## When a budget blocks a run

An explicit input cap requires a runtime that can verify the rendered prompt’s token count. A loaded LM Studio instance can supply that count and its active context. If preflight blocks the run, inspect the requested cap and active context. Shorten the prompt, choose a larger context, or revise the budget before starting again. A response that reached its output cap remains available to inspect. [Detailed budget behavior](https://github.com/niksacdev/dash/blob/main/docs/guides/workbench.md#evaluate-a-business-outcome)
