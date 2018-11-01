const elasticsearch = require('elasticsearch');
const async = require('async');
const _ = require('lodash');

module.exports = {
  afterConstruct: function(self, callback) {
    self.addReindexTask();
    return self.connect(callback);
  },
  construct: function(self, options) {
    self.fields = (self.options.fields || [ 'title', 'tags', 'type', 'lowSearchText', 'highSearchText' ]).concat(self.options.addFields || []);
    self.apos.define('apostrophe-cursor', require('./lib/cursor.js'));
    self.connect = function(callback) {
      self.baseName = self.options.baseName || self.apos.shortName;
      // Index names are restricted to lowercase letters
      self.docIndex = self.baseName.toLowerCase() + 'aposdocs';
      let host = null;
      const esOptions = (self.options.elasticsearchOptions || {});
      if (self.options.port) {
        host = (self.options.host || 'localhost') + ':' + self.options.port;
      } else {
        // Common convention with elasticsearch is one string with both host and port
        host = self.options.host || 'localhost:9200';
      }
      esOptions.host = esOptions.host || host;
      esOptions.apiVersion = esOptions.apiVersion || '6.4';

      self.client = new elasticsearch.Client(esOptions);
      return self.client.ping({
        requestTimeout: 5000
      }, callback);
    };

    self.docAfterSave = function(req, doc, options, callback) {
      const args = {
        body: self.getBulkIndexCommandsForDoc(req, doc, options),
        refresh: (!options.elasticsearchDefer).toString()
      };
      return self.client.bulk(args, callback);
    };

    // Return an array of parameters to `self.client.bulk` to
    // index the doc in question. There could be just one index
    // action description and one document body, or there could be
    // many such pairs, depending on workflow requirements.

    self.getBulkIndexCommandsForDoc = function(req, doc, options) {
      const commands = [];
      const body = {};
      _.each(self.fields, function(field) {
        const value = doc[field];
        let good = false;
        if (Array.isArray(value)) {
          if ((typeof value[0]) !== 'object') {
            good = true;
          }
        } else if ((typeof value) !== 'object') {
          good = true;
        }
        if (good) {
          body[field] = doc[field];
          // Allow exact matches of fields too without as much overthinking
          // of types, but don't redundantly store the 'exact' value where
          // it's too large to be requested that way anyway
          if (((!doc[field]) || JSON.stringify(doc[field]).length < 4096)) {
            body[field + 'ESExact'] = doc[field];
          }
        }
      });
      // No idea why it isn't cool to have this in the body too,
      // but ES flips out
      delete body._id;
      if (doc.workflowLocale) {
        commands.push({
          index: {
            _index: self.getLocaleIndex(doc.workflowLocale),
            _type: 'aposDoc',
            _id: doc._id
          }
        });
        commands.push(body);
      } else {
        // Not locale specific, so must appear in all locale indexes
        let locales = [ 'default' ];
        const workflow = self.apos.modules['apostrophe-workflow'];
        if (workflow) {
          locales = _.keys(workflow.locales);
        }
        _.each(locales, function(locale) {
          commands.push({
            index: {
              _index: self.getLocaleIndex(locale),
              _type: 'aposDoc',
              _id: doc._id
            }
          });
          commands.push(body);
        });
      }
      return commands;
    };

    self.indexNamesSeen = {};
    self.getLocaleIndex = function(locale) {
      locale = locale.toLowerCase();
      const indexName = self.docIndex + locale.replace(/[^a-z]/g, '');
      if (self.indexNamesSeen[indexName] && (self.indexNamesSeen[indexName] !== locale)) {
        throw new Error('apostrophe-elasticsearch: the locale names ' + locale + ' and ' + self.indexNamesSeen[indexName] + ' cannot be distinguished purely by their lowercased letters. elasticsearch allows no other characters in index names.');
      }
      self.indexNamesSeen[indexName] = locale;
      return indexName;
    };
    self.addReindexTask = function() {
      return self.addTask('reindex', 'Usage: node app apostrophe-elasticsearch:reindex\n\nYou should only need this task once under normal conditions.', self.reindexTask);
    };

    self.reindexTask = function(apos, argv, callback) {
      self.verbose('reindex task launched');
      return self.apos.locks.withLock('apostrophe-elasticsearch-reindex', function(callback) {
        return async.series([
          self.dropIndexes,
          self.createIndexes,
          self.index,
          self.refresh
        ], callback);
      });
    };

    // Drop all indexes. Called by the reindex task, otherwise not needed

    self.dropIndexes = function(callback) {
      self.verbose('dropping indexes');
      return self.client.cat.indices({
        h: ['index']
      }, function(err, result) {
        if (err) {
          return callback(err);
        }
        // Strange return format
        let indexes = (result || '').split(/\n/);
        indexes = _.filter(indexes, function(index) {
          return index.substr(0, self.docIndex.length) === self.docIndex;
        });
        if (!indexes.length) {
          return callback(null);
        }
        return self.client.indices.delete({
          index: indexes
        }, callback);
      });
    };

    self.getLocales = function() {
      const workflow = self.apos.modules['apostrophe-workflow'];
      return workflow ? _.keys(workflow.locales) : [ 'default' ];
    };

    // Create all indexes. Called by the reindex task, otherwise not needed
    self.createIndexes = function(callback) {
      self.verbose('creating indexes');
      const locales = self.getLocales();
      return async.eachSeries(locales, function(locale, callback) {
        const properties = {};
        _.each(self.fields, function(field) {
          properties[field] = {
            type: 'text'
          };
          properties[field + 'ESExact'] = {
            type: 'keyword'
          };
        });
        return self.client.indices.create({
          index: self.getLocaleIndex(locale),
          body: {
            settings: self.getLocaleSettings(locale),
            mappings: {
              aposDoc: {
                properties: properties
              }
            }
          }
        }, callback);
      }, callback);
    };

    self.getLocaleSettings = function(locale) {
      locale = locale.replace(/-draft$/, '');
      const settings = {};
      _.merge(settings, self.options.indexSettings || {});
      if (self.options.analyzer) {
        _.merge(settings, {
          'analysis': {
            'analyzer': self.options.analyzer
          }
        });
      }
      _.merge(settings, (self.options.localeIndexSettings || {})[locale] || {});
      if (self.options.analyzers && self.options.analyzers[locale]) {
        _.merge(settings, {
          'analysis': {
            'analyzer': self.options.analyzers[locale]
          }
        });
      }
      return settings;
    };

    // Index all documents. Called by the reindex task, otherwise not needed
    self.index = function(callback) {
      const batchSize = self.options.batchSize || 100;
      const req = self.apos.tasks.getReq();
      self.verbose('Indexing all documents');
      let reindexed = 0;
      let last = '';
      let count;
      self.verbose('Counting docs for progress display');
      return self.apos.docs.db.count(function(err, _count) {
        if (err) {
          return callback(err);
        }
        count = _count;
        // Do the next batch, recursively
        return nextBatch(callback);
      });
      function nextBatch(callback) {
        return self.apos.docs.db.find({
          _id: { $gt: last }
        }).sort({ _id: 1 }).limit(batchSize).toArray(function(err, docs) {
          if (err) {
            return callback(err);
          }
          if (!docs.length) {
            // This is how we terminate successfully
            return callback(null);
          }
          last = docs[docs.length - 1]._id;
          return indexBatch(docs, function(err) {
            if (err) {
              return callback(err);
            }
            return nextBatch(callback);
          });
        });
      }
      function indexBatch(docs, callback) {
        reindexed += docs.length;
        const percent = Math.floor(reindexed / count * 100 * 100) / 100;
        self.verbose(`Indexed ${reindexed} of ${count} (${percent}%)`);
        const args = {
          body: _.flatten(
            _.map(docs, function(doc) {
              return self.getBulkIndexCommandsForDoc(req, doc, {});
            })
          )
        };
        return self.client.bulk(args, callback);
      }
    };

    // Refresh the index (commit it so it can be used). Called by the reindex task
    // once at the end for efficiency
    self.refresh = function(callback) {
      self.verbose('refreshing');
      const locales = self.getLocales();
      const indexes = _.map(locales, self.getLocaleIndex);
      return self.client.indices.refresh({ index: indexes }, callback);
    };

    self.verbose = function(s) {
      if (self.apos.argv.verbose || self.options.verbose) {
        self.apos.utils.info(self.__meta.name + ': ' + s);
      }
    };
  }
};
