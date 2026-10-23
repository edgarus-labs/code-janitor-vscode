import { nodeVersionProblem } from './nodeVersion';

console.log(
  `Node.js ${process.version} on ${process.platform}-${process.arch}; runner image ${process.env.ImageOS ?? 'unknown'} ${process.env.ImageVersion ?? 'unknown'}`
);

const problem = nodeVersionProblem(process.version);
if (problem) {
  console.error(problem);
  process.exitCode = 1;
}
