# 0013. License DASH-owned materials under Apache 2.0

**Status** Accepted

This is the first decision on project licensing. Nik authorized a permissive license change so that a team redistributing the desktop application or a domain pack can identify its source and carry the appropriate credit.

The previous MIT license already required retention of its copyright and permission notices. Apache 2.0 provides a defined mechanism for attribution in redistributed derivatives and an express contributor patent grant. Retaining MIT was a simpler option. We chose the unmodified Apache 2.0 text and a short, factual notice naming Nik Sachdeva. Both licenses allow commercial reuse. [Apache License, sections 3 and 4](https://www.apache.org/licenses/LICENSE-2.0)

The change covers DASH-owned materials from this revision forward, including the authored code, documentation, prompts, graders and synthetic cases. Earlier copies keep the terms under which they were received. Third-party components and model marks keep their own terms. Customer datasets and model responses retain their applicable terms. Ordinary scores can be shared without a DASH badge. Someone redistributing a domain pack, including through an export that contains its cases, must observe the license for the materials they redistribute. [Previous project license](https://github.com/niksacdev/dash/blob/cd71d3a3de38300421eb6bba76da7e5dc3221a5b/LICENSE)

A desktop build must carry byte-identical copies of the project license, attribution notice and bundled model-logo license. A regression test reads the built files and compares them with their sources. [Redistribution guide](../../README.md#license) · [Implementation and review](https://github.com/niksacdev/dash/pull/13)
