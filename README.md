# mservicebus

mservicebus is an opinionated implementation of a service bus.

In today's microservices-style architectures, messaging is the integration
mechanism of choice. A service bus is an abstraction on message exchange
patterns, and forms the fabric that holds the microservices together.

mservicebus lays emphasis on scalability, flexibility and simplicity, whilst
the espousing key ideas that: 

- Microservices provide actions - command and queries
- Microservice publish events
- Microservices should be able to replay events.

## Getting started

```
npm install mservice bus
```
## Actions

Actions - commands or queries, are remote procedure calls.
mservicebus provides a fluent api for defining actions. It provides both 
promise and callback apis for invoking actions.

```
var Servicebus = require('servicebus');
var servicebus = new Servicebus({
	//options for amqp and timeouts
});

//invoke an action
servicebus.invoke('myotherservice.query1', {param1:'value1'}, function(err, results){
	// put code to handle error or use results here
});

//define an action using the fluent api
servicebus.action('myservice.command1')
	.before(function(request, next){	//use simple middleware
		//put code to execute middleware action
	})
	.after(function(request, response, next){
		// put code to be executed after action is performed
	})
	.correct(function(err, args, next){	//use error middleware
		//put code to handle error here
	})
	.perform(function(args, done){
		//put code to perform the action 
	});

//define an action using a direct api
servicebus.action('myservice.command2', function(args, done){
	/put code to perform action here
});
servicebus.before('myservice.command2', function(args, done){
	//put code to execute middleware action here
});

servicebus.after('myservice.command2', function(args, done){
	//put code to be executed after the action is performed here
});

servicebus.correct('myservice.command2', function(err, args, done){
	/put code to handle the error here;
});

```

## Event publications
```
servicebus.subscribe('myotherservice.stock.nyse.#', function(event){
	//put code to handle event here
});

servicebus.publish('myservice.stock.acme', {
	//event data goes here
});
```

##Event replay
```
servicebus.replay('myservice.event.stream', function(args, stream){
	eventStore.getEvent(args, function(events){
		events.forEach(function(event){
			stream.write(event);
		});
		stream.close();
});

servicebus.requestReplay('myotherservice.event.name', function(err, stream){
	//put code to handle error, or read event objects from stream
})
```

## Contributing

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request :D

## History

TODO: Write history

## Credits

Adedayo Omitayo 
	- https://github.com/Aomitayo

## License

[MIT](LICENSE)
