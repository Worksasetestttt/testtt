// Port libre attribué par le système (plage éphémère) pour le serveur d'une suite de tests : plusieurs suites, ou
// plusieurs copies du dépôt, peuvent tourner en même temps sans se disputer un port tiré au hasard dans une même plage.
import net from 'node:net';

export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
