import React from 'react';
import { useStore } from './state/store.js';
import { KeySetup } from './screens/KeySetup.tsx';
import { ApiKeys } from './screens/ApiKeys.tsx';
import { PickRoutes } from './screens/PickRoutes.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { SummarizeTasks } from './screens/SummarizeTasks.tsx';
import { MethodologyCheck } from './screens/MethodologyCheck.tsx';
import { PickTasks } from './screens/PickTasks.tsx';
import { TaskDetail } from './screens/TaskDetail.tsx';
import { PickModels } from './screens/PickModels.tsx';
import { PickDestinations } from './screens/PickDestinations.tsx';
import { Confirm } from './screens/Confirm.tsx';
import { LiveProgress } from './screens/LiveProgress.tsx';

export function App() {
  const screen = useStore((s) => s.screen);
  switch (screen) {
    case 'keySetup':         return <KeySetup />;
    case 'apiKeys':          return <ApiKeys />;
    case 'pickRoutes':       return <PickRoutes />;
    case 'onboarding':       return <Onboarding />;
    case 'summarizeTasks':   return <SummarizeTasks />;
    case 'methodologyCheck': return <MethodologyCheck />;
    case 'pickTasks':        return <PickTasks />;
    case 'taskDetail':       return <TaskDetail />;
    case 'pickModels':       return <PickModels />;
    case 'pickDestinations': return <PickDestinations />;
    case 'confirm':          return <Confirm />;
    case 'liveProgress':     return <LiveProgress />;
  }
}
