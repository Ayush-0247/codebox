import { getExecutor } from '../executor/ExecutorFactory.js';
import { getLanguageById } from '../languages/index.js';
import logger from '../utils/logger.js';

// One tiny program per language. Running them right after the worker starts
// pulls the compilers, the C++ precompiled header and the javac class archive
// into the page cache, so the first user after a restart gets warm timings.
const PROGRAMS = [
  [54, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){long long a,b;cin>>a>>b;cout<<a+b;}'],
  [62, 'import java.util.*;\npublic class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.print(s.nextLong()+s.nextLong());}}'],
  [50, '#include <stdio.h>\nint main(){long long a,b;scanf("%lld %lld",&a,&b);printf("%lld",a+b);}'],
  [74, 'declare const require: any;\nconst [a, b]: number[] = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);\nconsole.log(a + b);'],
  [71, 'a,b=map(int,input().split());print(a+b)'],
  [63, 'const [a,b]=require("fs").readFileSync(0,"utf8").trim().split(/\\s+/).map(Number);console.log(a+b)'],
];

export async function warmUpExecutor() {
  const executor = getExecutor();
  const start = Date.now();
  const timings = {};
  for (const [languageId, source] of PROGRAMS) {
    const language = getLanguageById(languageId);
    if (!language) continue;
    const t = Date.now();
    const result = await executor.execute({
      token: `warmup-${languageId}`,
      language,
      language_id: languageId,
      source_code: source,
      stdin: '1 2',
      cpu_time_limit: 5,
      wall_time_limit: 10,
      memory_limit: 256000,
      max_processes_and_or_threads: 60,
      max_file_size: 1024,
    });
    timings[language.name] = `${Date.now() - t}ms ${result.status?.description}`;
  }
  logger.info({ event: 'worker_warmup_done', durationMs: Date.now() - start, timings });
}

export default warmUpExecutor;
