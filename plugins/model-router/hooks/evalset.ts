import type { Difficulty, EvalCase, Rigor } from '../types'

const cases = (difficulty: Difficulty, rigor: Rigor, texts: readonly string[]): EvalCase[] =>
  texts.map(text => ({ text, difficulty, rigor }))

/**
 * Labeled prompts, in Portuguese and English, that `/route eval` runs through
 * the router. The labels say what a careful person would pick, so a change to
 * the rules or to the classifier prompt can be measured before it ships.
 */
export const EVAL_SET: readonly EvalCase[] = [
  ...cases('simple', 'light', [
    'git status',
    'rode os testes',
    'qual é a porta padrão do servidor de dev?',
    'liste os arquivos em src/hooks',
    'rename the variable usrCnt to userCount in utils/format.ts',
    'corrija o typo "recieve" no README',
    'what does the --frozen-lockfile flag do?',
    'formate o arquivo package.json',
    'show me the last 5 commits',
    'onde fica definida a função parseVerdict?',
    'bump the version in plugin.json to 0.3.0',
    'instale a dependência zod',
    'remove the unused import in src/app.ts',
    'qual a diferença entre let e const?',
  ]),
  ...cases('standard', 'normal', [
    'Add pagination to the orders endpoint and update the tests',
    'crie um endpoint GET /health que retorna a versão e o uptime',
    'escreva testes unitários para o módulo de parser de datas',
    'add a --json flag to the export command that prints the result as JSON',
    'documente no README como configurar as variáveis de ambiente',
    'adicione validação de email e telefone no formulário de cadastro',
    'create a React component for the user avatar with a fallback to initials',
    'adicione um campo "telefone" ao cadastro de cliente: entidade, DTO, formulário e teste',
    'write a script that converts the CSV exports in data/ to JSON',
    'implemente o comando /stats que mostra o total de tokens por dia',
    'add a dark mode toggle to the settings page and persist the choice',
    'crie a página de listagem de pedidos com filtro por status',
    'extract the duplicated date formatting in the three report components into one helper',
    'adicione logs estruturados nas rotas de pagamento',
  ]),
  ...cases('standard', 'careful', [
    'o botão de salvar fica desabilitado depois de um erro de validação; o estado isSubmitting não volta para false, corrija',
    'fix the off-by-one in the pagination: the last page repeats the final item of the previous page',
    'a função formatCurrency arredonda errado valores negativos, corrija e cubra com testes',
    'the login form accepts emails with trailing spaces and then fails to match; trim them and add a test',
    'troque a biblioteca moment por date-fns no módulo de relatórios sem mudar a saída',
    'change the retry policy of the HTTP client from 3 fixed attempts to exponential backoff',
    'o endpoint /orders devolve 500 quando a lista está vazia porque faz reduce sem valor inicial; corrija',
    'update the price calculation to apply the discount before tax instead of after',
    'o filtro de datas ignora o fuso horário do usuário; passe a usar o fuso do perfil',
    'make the upload endpoint reject files over 10 MB with a 413 instead of crashing',
  ]),
  ...cases('hard', 'normal', [
    'Design the plugin architecture for the CLI: how plugins are discovered, loaded and isolated',
    'proponha um modelo de dados para multi-tenant neste serviço e o plano de implementação',
    'planeje como dividir o monólito de faturamento em módulos com fronteiras claras',
    'design a caching layer for the product catalog API, with invalidation rules',
    'escreva um plano para adicionar suporte offline ao app mobile',
    'compare three approaches to real-time updates for the dashboard and recommend one',
  ]),
  ...cases('hard', 'careful', [
    'Investigate why the cache invalidation drops writes under load',
    'os testes de integração falham de forma intermitente no CI e passam local, descubra a causa',
    'Refactor the billing module so invoices and refunds share one ledger',
    'a API ficou 3x mais lenta depois do último deploy, encontre o motivo e corrija',
    'there is a memory leak in the worker process; find it',
    'refatore o módulo de autenticação para separar domínio e infraestrutura sem mudar o comportamento',
    'the app freezes for a few seconds when opening large projects; profile it and fix the cause',
    'o webhook de pagamento às vezes é processado duas vezes, investigue',
    'reduce the cold start time of the lambda functions, currently around 4 seconds',
    'o build de produção quebra só no Windows com um erro de path, descubra por quê',
  ]),
  ...cases('critical', 'careful', [
    'there is a race condition between the payment confirmation and the stock reservation; fix it',
    'corrija a vulnerabilidade de SQL injection no endpoint de busca e verifique os outros endpoints',
    'escreva o script que apaga os dados de usuários inativos há mais de 5 anos em produção',
  ]),
  ...cases('critical', 'deep', [
    'Migrate the orders table to the new schema without downtime',
    'faça uma revisão de segurança do fluxo de login e de recuperação de senha',
    'rewrite the sync engine to be conflict-free across devices',
    'migre a autenticação de sessões em cookie para JWT com rotação de refresh token',
    'audit the codebase for secrets and unsafe deserialization',
  ]),
]
