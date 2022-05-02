const { EventEmitter } = require('events');
const { promisify: p, format, inspect } = require('util');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const ip = require('ip');

const sprintf = require('sprintf-js').sprintf;
const { Command, flags } = require('@oclif/command');
const debug = require('debug')('commands:probe');
const chalk = require('chalk');
const highlight = require('cli-highlight').highlight;
const temp = require('temp').track();
const mime = require('mime-types');
const jmespath = require('jmespath');
const YAML = require('js-yaml');

const telemetry = require('../telemetry').init();
const HttpEngine = require('../../core/lib/engine_http');
const { expectations, formatters } = require('artillery-plugin-expect');

function fmt(val, padTo = 8) {
  return chalk.cyan(
    sprintf(`%-${padTo}s`, typeof val === 'number' ? val + 'ms' : val)
  );
}

function parse(str) {
  const format1 = /^[A-Za-z0-9\-_]+=[A-Za-z0-9\-_]+$/i;
  const format2 = /^[A-Za-z0-9\-_]+:[A-Za-z0-9\-_]+$/i;

  if (format1.test(str)) {
    const components = str.split('=');
    const result = {};
    result[components[0]] = components[1];
    debug('parse: format1:', str, result);
    return result;
  }

  if (format2.test(str)) {
    const components = str.split(':');
    const result = {};
    result[components[0]] = components[1];
    debug('parse: format2:', str, result);
    return result;
  }

  let result;
  try {
    result = YAML.safeLoad(str);
    debug('parse: YAML:', str, result);
  } catch (parseErr) {
    throw parseErr;
  }

  return result;
}

const VERBS = [
  'get',
  'post',
  'put',
  'delete',
  'head',
  'options',
  'patch',
  'connect',
  'trace'
];

class ProbeCommand extends Command {
  static aliases = ['probe', 'http'];
  // Enable multiple args:
  static strict = false;
  pipingJMESPathOutput = false;
  outputtingJSON = false;
  suggestedExitCode = 0;

  log () {
    if (!this.pipingJMESPathOutput && !this.outputtingJSON) {
      console.log.apply(console, arguments);
    }
  }

  async run() {
    debug('probe:run');

    const { flags, argv, args } = this.parse(ProbeCommand);

    if (flags.pretty) {
      flags.showBody = true;
    }

    if (flags.jmespath) {
      this.pipingJMESPathOutput = true;
    }
    if (flags.outputJson) {
      this.outputtingJSON = true;
    }

    debug({ flags, args, argv });

    const targetType = 'http';
    const method = 'get';

    if (!args.target && !args.method) {
      this._help();
    }

    let verb;
    let target;
    if (VERBS.indexOf(args.method.toLowerCase()) === -1) {
      verb = 'get';
      target = args.method;
    } else {
      verb = args.method;
      target = args.target;
    }

    // Default to HTTPS if no protocol on the URL
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = `https://${target}`;
    }

    const script = {
      config: {
        target: target,
        http: {
          extendedMetrics: true
        },
        processor: {
          captureRequestDetails: (req, res, context, events, next) => {
            context.vars.requestHeaders = res.req._header;
            context.vars.ip = res.ip;
            context.vars.statusCode = res.statusCode;
            context.vars.httpVersion = res.httpVersion;
            context.vars.statusMessage = res.statusMessage;
            context.vars.headers = res.headers;
            context.vars.body = res.body;
            context.vars.status = res.statusCode;
            context.vars.timings = res.timings;

            context.vars.req = req;
            context.vars.res = res;
            next();
          }
        }
      },
      scenarios: [
        {
          flow: [
          ]
        }
      ]
    };

    //
    // Construct request spec:
    //
    script.scenarios[0].flow[0] = {};
    const requestSpec = {
      url: target,
      afterResponse: 'captureRequestDetails',
    };

    // Basic auth:
    if (flags.auth) {
      let auth;
      try {
        auth = parse(flags.auth);
      } catch (parseErr) {
        console.error(chalk.red('Could not parse value of --auth as valid JSON or YAML'));
        console.error(chalk.red(parseErr.message));
        console.error('Example: --auth {user: tiki, pass: pony1}');
        process.exit(1);
      }
      requestSpec.username = auth.user;
      requestSpec.password = auth.pass;
    }

    // JSON body:
    if(flags.json) {
      let jsonBody;
      try {
        jsonBody = parse(flags.json);
      } catch (parseErr) {
        console.error(chalk.red('Could not parse value of --json as valid JSON or YAML'));
        console.error(chalk.red(parseErr.message));
        console.error('Example: --json "{name: Tiki, species: pony}"');
        process.exit(1);
      }
      debug(jsonBody);
      requestSpec.json = jsonBody;
    }

    // Headers:
    if (flags.headers?.length > 0) {
      let headers = {};
      for(const h of flags.headers) {
        try {
          const header = parse(h);
          headers = Object.assign({}, headers, header);
        } catch (parseErr) {
          console.error(chalk.red('Could not parse value of --header as valid JSON or YAML or key-value string'));
          console.error(chalk.red(h));
          console.error(chalk.red(parseErr.message));
          console.error('Example: --header "x-my-header: my-value"');
          process.exit(1);
        }
      }
      requestSpec.headers = headers;
    }

    // Querystrings:
    if (flags.qs?.length > 0) {
      let qs = {};
      for (const q of flags.qs) {
        try {
          const querystring = parse(q);
          qs = Object.assign({}, qs, querystring);
        } catch (parseErr) {
          console.error(chalk.red('Could not parse value of --qs as valid JSON, YAML or key-value string'));
          console.error(chalk.red(h));
          console.error(chalk.red(parseErr.message));
          console.error('Example: --qs "keyword=pony"');
          process.exit(1);
        }
      }
      requestSpec.qs = qs;
    }

    // Body:
    if (flags.body) {
      requestSpec.body = flags.body;
    }

    requestSpec.http2 = true;

    // Set spec
    script.scenarios[0].flow[0][verb] = requestSpec;

    if (flags.insecure) {
      script.config.tls = {
        rejectUnauthorized: !flags.insecure
      };
    }

    // Expectations:
    let checks = [];
    if (flags.expect?.length > 0) {
      for (const ex of flags.expect) {
        try {
          const expectation = parse(ex);
          checks.push(expectation);
        } catch (parseErr) {
          console.error(chalk.red('Could not parse value of --expect as valid JSON or YAML or key-value string'));
          console.error(chalk.red(ex));
          console.error(chalk.red(parseErr.message));
          console.error('Example: --expect "{statusCode: 200}"');
          process.exit(1);
        }
      }
    }

    debug(JSON.stringify(script, null, 4));
    const engine = new HttpEngine(script);
    const events = new EventEmitter();

    const vu = p(engine.createScenario(script.scenarios[0], events));
    const initialContext = {
      vars: {}
    };
    try {
      debug('probe:vu:start');
      const context = await vu(initialContext);
      debug('probe:vu:end');

      const TEMPLATE =
        `` +
        `DNS Lookup | TCP Connection | SSL Handshake | Time to First Byte | Content Transfer  ` +
        '\n' +
        `  %s|  %s|     %s|     %s|   %s |\n` +
        `            |                |               |                    |                 |` +
        '\n' +
        `            %s         |               |                    |                 |` +
        '\n' +
        `                          %s           |                    |                 |` +
        '\n' +
        `                                           %s               |                 |` +
        '\n' +
        `                                                                %s            |` +
        '\n' +
        `                                                                               total:%s` +
        '\n';

      const timings = context.vars.timings;
      const phases = timings.phases;

      this.log(`Connected to ${target} (${chalk.cyan(context.vars.ip)})\n`);

      if (flags.verbose) {
        this.log(chalk.cyan('Request:\n'));
        this.log(context.vars.requestHeaders);
      }


      if (flags.verbose) {
        this.log(chalk.cyan('Response:\n'));
      }
      this.log(
        `HTTP/${context.vars.httpVersion} ${
          context.vars.statusCode < 400
            ? chalk.green(context.vars.statusCode, context.vars.statusMessage)
            : chalk.red(context.vars.statusCode, context.vars.statusMessage)
        }`
      );

      for (const headerName of Object.keys(context.vars.headers)) {
        this.log(
          `${headerName}: ${chalk.blue(context.vars.headers[headerName])}`
        );
      }

      this.log(
        '\n\n',
        format(
          TEMPLATE,
          // Phase durations:
          fmt(phases.dns, 10),
          fmt(phases.tcp, 14),
          fmt(phases.tls || 'N/A', 10),
          fmt(phases.firstByte, 15),
          fmt(phases.download, 13),
          // Cumulative:
          fmt(phases.dns),
          fmt(timings.connect - timings.socket),
          fmt((timings.secureConnect || timings.connect) - timings.socket),
          fmt(timings.response - timings.socket),
          fmt(timings.end - timings.socket)
        ).replace(/\|/g, chalk.gray('|'))
      );

      const contentType =
        context.vars.headers?.['content-type'] || 'application/octet-stream';
      if (context.vars.body) {
        const suffix = mime.extension(contentType);
        const fn = temp.path({ suffix: `.${suffix}` });
        fs.writeFileSync(fn, context.vars.body);
        this.log(`\n${chalk.cyan('Body')} stored in: ${fn}\n`);
      }

      if (flags.showBody) {
        let language;
        if (contentType.match(/json/gi)) {
          language = 'json';
        }
        if (contentType.match(/html/gi)) {
          language = 'html';
        }

        if (language) {
          let output = context.vars.body;
          if (language === 'json' && flags.pretty) {
            output = JSON.stringify(JSON.parse(context.vars.body), null, 4);
          }
          this.log(highlight(output, { language }));
        } else {
          this.log(context.vars.body);
        }
      }

      if (flags.jmespath) {
        if (!contentType.match(/json/g)) {
          console.error(
            chalk.yellow('Response Content-Type is not JSON:'),
            contentType
          );
          console.error(chalk.yellow('Trying JMESPath expression anyway'));
        }

        try {
          const json = JSON.parse(context.vars.body);
          const result = jmespath.search(json, flags.jmespath);

          // If our output is piped we want to print the JSON without highlighting:
          if (process.stdout.isTTY) {
            console.log(highlight(JSON.stringify(result), { language: 'json' }));
          } else {
            console.log(JSON.stringify(result));
          }

        } catch (err) {
          console.error(chalk.red(err.message));
          process.exit(1);
        }
      }

      if (checks.length > 0) {
        this.log(chalk.cyan('Expectations:\n'));
        let results = [];

        for(const ex of checks) {
          const checker = Object.keys(ex)[0];
          let result = expectations[checker].call(this, ex, context.vars.body, context.vars.req, context.vars.res, {});
          results.push(result);
        }

        const failedExpectations = results.filter(res => !res.ok).length > 0;

        if (failedExpectations) {
          this.suggestedExitCode = 1;
        }

        results.forEach(result => {
          this.log(
            `*  ${result.ok ? chalk.green('ok') : chalk.red('not ok')} ${
              result.type
            } ${result.got} `
          );

          if (!result.ok) {
            this.log(`   expected: ${result.expected}`);
            this.log(`        got: ${result.got}`);
          }
        });
      }

      await sendTelemetry(verb, target, args, flags);

      process.exit(this.suggestedExitCode);
    } catch (vuErr) {
      console.error(vuErr);
      process.exit(1);
    }
  }
}

async function sendTelemetry(method, target, args, flags) {
  function hash(str) {
    return crypto.createHash('sha1').update(str).digest('base64');
  }

  const properties = {};

  properties.method = method;
  properties.usesExpectations = flags.expect;
  properties.usesJmesPath = flags.jmespath;

  try {
    const targetHash = hash(target);
    properties.targetHash = targetHash;
    properties.distinctId = properties.targetHash;

    const ipaddr = ip.address();
    let macaddr;
    for (const [iface, descrs] of Object.entries(os.networkInterfaces())) {
      for (const o of descrs) {
        if (o.address === ipaddr) {
          macaddr = o.mac;
          break;
        }
      }
    }

    if (macaddr) {
      properties.macHash = hash(macaddr);
    }
    properties.ipHash = hash(ipaddr);
    properties.hostnameHash = hash(os.hostname());
    properties.usernameHash = hash(os.userInfo().username);
  } catch (err) {
    debug(err);
  } finally {
    telemetry.capture('commands:probe', properties);
  }
}

ProbeCommand.description = `Swiss Army Knife For Testing HTTP


⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⡟⢻⣿⣿⣿⣿⣿⣿⡀⢀⣀⣀⣉⠙⠻⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⡃⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⠛⠿⠷⠀⠀⢀⣽⠿⠿⠿⣿⣿⣿⣿⣿⣿⣿
⣿⣿⡇⢠⠀⢹⣿⣿⣿⣿⣿⣿⣿⣷⣦⣀⢀⣴⠟⢁⡀⢀⡀⠈⢻⣿⣿⣿⣿⣿
⣿⣿⣷⠸⡇⠀⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠟⠁⠀⢈⣿⣿⡁⠀⢸⣿⣿⣿⣿⣿
⣿⣿⣿⡆⠀⠀⠘⣿⣿⣿⣿⣿⣿⣿⠟⠁⠀⠀⠀⠈⠁⠈⢁⣴⠿⣿⣿⣿⣿⣿
⣿⣿⣿⣷⠀⠀⠀⢹⣿⣿⣿⣿⠟⠁⠀⠀⠀⠀⠀⠀⢀⣴⣟⠁⠀⠸⣿⣿⣿⣿
⣿⣿⣿⣿⡀⠀⠀⠀⢿⣿⠟⠁⠀⠀⠀⠀⠀⠀⢀⣴⣿⣿⣿⡃⠀⠀⣿⣿⣿⣿
⣿⣿⣿⣿⣇⠀⢀⣴⠟⠁⠀⠀⠀⠀⠀⠀⢀⣴⣿⣿⣿⣿⣿⣟⠀⠀⠸⣿⣿⣿
⣿⣿⣿⣿⣿⣶⠟⠁⠀⠀⠀⠀⠀⠀⢀⣴⠿⠿⠿⢿⣿⣿⣿⣿⡁⠀⠀⢻⣿⣿
⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⢀⣴⣿⣿⣷⣴⠀⠘⢉⣿⣿⣿⣏⡀⠀⠘⣿⣿
⣿⣿⣿⣿⣿⣧⡀⠀⠀⠀⢀⣴⣿⣿⣿⣿⣿⣧⣤⠀⠈⢀⣿⣿⣿⣇⣠⣴⣿⣿
⣿⣿⣿⣿⡿⠟⠛⢶⣶⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣮⣀⣠⣼⣿⣿⣿⣿⣿⣿⣿
⣿⣿⠿⣋⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
⣿⣷⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿

Swiss Army Knife For Testing HTTP. Probe HTTP URLs, visualize request
performance, send arbitrary HTTP requests, and run expectations and
checks.

Examples:

    Check response headers and visualize request performance:

        $ artillery http www.artillery.io

    Use Basic HTTP Authentication with a username and password:

        $ artillery http --auth "{user: tiki, pass: pony1}" www.artillery.io/secret

Docs:

  More examples: https://docs.art/examples/http-cli
  Testing HTTP with Artillery: https://docs.art/http-reference

Supported HTTP methods: GET, POST, HEAD, PATCH, DELETE, PUT, OPTIONS
If the protocol is not specified, Artillery will default to "https://"
`;

// TODO: Link to an Examples section in the docs

ProbeCommand.flags = {
  insecure: flags.boolean({
    char: 'k',
    description: 'Allow insecure TLS connections; do not use in production'
  }),
  showBody: flags.boolean({
    char: 'b',
    description: 'Show response body'
  }),
  pretty: flags.boolean({
    char: 'p',
    description: 'Pretty-print JSON responses'
  }),
  verbose: flags.boolean({
    char: 'v',
    description: 'Print request headers'
  }),
  jmespath: flags.string({
    char: 'q',
    description:
      'Run a JMESPath query on a JSON response body (https://docs.art/jmespath)'
  }),
  outputJson: flags.boolean({
    char: 'j',
    description: 'Format all output as JSON'
  }),
  expect: flags.string({
    char: 'e',
    multiple: true,
    description: 'Set expectation checks on response'
  }),

  // HTTP options:
  auth: flags.string({
    description: 'Set HTTP Basic Authentication credentials'
  }),
  json: flags.string({
    description: 'Set JSON body for request'
  }),
  qs: flags.string({
    description: 'Set querystring',
    multiple: true,
  }),
  headers: flags.string({
    char: 'H',
    description: 'Set request headers',
    multiple: true
  }),
  body: flags.string({
    description: 'Set request body',
  })
};

ProbeCommand.args = [
  {
    name: 'method',
    required: false
  },
  {
    name: 'target',
    required: false
  }
];

module.exports = ProbeCommand;