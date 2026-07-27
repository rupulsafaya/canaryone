import React from 'react';
import { useStore } from './state/store.js';
import { Onboarding } from './screens/Onboarding.tsx';
import { PickTasks } from './screens/PickTasks.tsx';
import { PickModels } from './screens/PickModels.tsx';
import { Confirm } from './screens/Confirm.tsx';
import { LiveProgress } from './screens/LiveProgress.tsx';
import { Report } from './screens/Report.tsx';

export function App() {
  const screen = useStore((s) => s.screen);
  switch (screen) {
    case 'onboarding':   return <Onboarding />;
    case 'pickTasks':    return <PickTasks />;
    case 'pickModels':   return <PickModels />;
    case 'confirm':      return <Confirm />;
    case 'liveProgress': return <LiveProgress />;
    case 'report':       return <Report />;
  }
}
