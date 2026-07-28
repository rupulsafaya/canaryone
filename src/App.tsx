import React from 'react';
import { useStore } from './state/store.js';
import { Onboarding } from './screens/Onboarding.tsx';
import { PickTasks } from './screens/PickTasks.tsx';
import { TaskDetail } from './screens/TaskDetail.tsx';
import { PickModels } from './screens/PickModels.tsx';
import { PickHosts } from './screens/PickHosts.tsx';
import { Confirm } from './screens/Confirm.tsx';
import { LiveProgress } from './screens/LiveProgress.tsx';

export function App() {
  const screen = useStore((s) => s.screen);
  switch (screen) {
    case 'onboarding':   return <Onboarding />;
    case 'pickTasks':    return <PickTasks />;
    case 'taskDetail':   return <TaskDetail />;
    case 'pickModels':   return <PickModels />;
    case 'pickHosts':    return <PickHosts />;
    case 'confirm':      return <Confirm />;
    case 'liveProgress': return <LiveProgress />;
  }
}
