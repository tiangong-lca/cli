import { statisticsSelection } from '../application/process-statistics.js';
import { readCommandInput } from '../shared/command-files.js';
import { CommandInputError } from '../shared/command-result.js';

export function statisticsRequest(values: Record<string, string | boolean | undefined>) {
  const selectionFlags = ['scope', 'owner', 'state', 'group-by', 'max-rows'];
  if (values.input !== undefined && selectionFlags.some((key) => values[key] !== undefined))
    throw new CommandInputError(
      'INPUT_AMBIGUOUS',
      'Use --input or explicit statistics selection options, not both.',
    );
  const request =
    values.input !== undefined
      ? readCommandInput(String(values.input))
      : {
          ...(values.scope === undefined ? {} : { scope: values.scope }),
          ...(values.owner === undefined ? {} : { owner: values.owner }),
          ...(values.state === undefined ? {} : { stateCodes: [Number(values.state)] }),
          ...(values['group-by'] === undefined
            ? {}
            : { groupBy: String(values['group-by']).split(',') }),
          ...(values['max-rows'] === undefined ? {} : { maxRows: Number(values['max-rows']) }),
        };
  statisticsSelection(request);
  return request;
}
