# Quickstart

Install the SDK and send your first event in under a minute.

```sh
npm install @nimbus/sdk
```

```ts
import { Nimbus } from '@nimbus/sdk'

const nimbus = new Nimbus({ projectId: process.env.NIMBUS_PROJECT_ID })

await nimbus.track('page_view', { path: '/pricing' })
```

Events are accepted at the nearest edge location and queryable within a second.
